import type { ColorMode } from '../../core/types';
import frameStoreShaderCode from './shaders/frameStore.wgsl';

// Keeps frames around for ping-pong video without keeping pixels: each frame
// is reduced to the one value its colour comes from (θ₂ or flip time) at
// 16 bits per pixel and held in memory. Restoring writes it back into the
// state buffer, where the normal renderer draws it exactly as before.
export class FrameStore {
  private device!: GPUDevice;
  private byteLength = 0;
  private paramsBuffer!: GPUBuffer;
  private packedBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;
  private packPipeline!: GPUComputePipeline;
  private unpackPipeline!: GPUComputePipeline;
  private readonly staging: GPUBuffer[] = [];
  private readonly freeStaging: GPUBuffer[] = [];

  // Bytes held in memory per stored frame.
  static bytesPerFrame(pixelCount: number): number {
    return Math.ceil(pixelCount / 2) * 4;
  }

  async init(device: GPUDevice, stateBuffer: GPUBuffer, pixelCount: number, colorMode: ColorMode, maxFlipTime: number): Promise<void> {
    this.device = device;
    this.byteLength = FrameStore.bytesPerFrame(pixelCount);

    // Params: count, colorMode, maxFlipTime + pad = 16 bytes
    const params = new ArrayBuffer(16);
    new Uint32Array(params).set([pixelCount, colorMode === 'theta2' ? 0 : 1]);
    new Float32Array(params)[2] = maxFlipTime;
    this.paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.paramsBuffer, 0, params);

    this.packedBuffer = device.createBuffer({
      size: this.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const module = device.createShaderModule({ code: frameStoreShaderCode });
    [this.packPipeline, this.unpackPipeline] = await Promise.all([
      device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'pack' } }),
      device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'unpack' } }),
    ]);

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 1, resource: { buffer: this.paramsBuffer } },
        { binding: 2, resource: { buffer: this.packedBuffer } },
      ],
    });
  }

  // Captures the current frame. Safe to call again before earlier saves resolve.
  async save(): Promise<ArrayBuffer> {
    const staging = this.freeStaging.pop() ?? this.createStaging();
    const enc = this.device.createCommandEncoder();
    this.dispatch(enc, this.packPipeline);
    enc.copyBufferToBuffer(this.packedBuffer, 0, staging, 0, this.byteLength);
    this.device.queue.submit([enc.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const frame = staging.getMappedRange().slice(0);
    staging.unmap();
    this.freeStaging.push(staging);
    return frame;
  }

  // Writes a saved frame back into the state buffer, ready to render.
  restore(frame: ArrayBuffer): void {
    this.device.queue.writeBuffer(this.packedBuffer, 0, frame);
    const enc = this.device.createCommandEncoder();
    this.dispatch(enc, this.unpackPipeline);
    this.device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    this.paramsBuffer?.destroy();
    this.packedBuffer?.destroy();
    for (const b of this.staging) b.destroy();
  }

  private createStaging(): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: this.byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.staging.push(buffer);
    return buffer;
  }

  private dispatch(enc: GPUCommandEncoder, pipeline: GPUComputePipeline): void {
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.byteLength / 4 / 256));
    pass.end();
  }
}
