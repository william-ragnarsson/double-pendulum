import type { ColorMode, Palette } from '../../core/types';
import { PALETTE_INDEX } from './PhaseMapRenderer';
import paletteShaderCode from './shaders/palette.wgsl';
import quantizeShaderCode from './shaders/gifQuantize.wgsl';

export interface GifQuantizerOptions {
  colorMode: ColorMode;
  palette: Palette;
  maxFlipTime: number;
  colors: number;  // GIF colour-table size: a power of two ≤ 256
}

// Turns the simulation state into GIF palette indices on the GPU.
// The palette is sampled from the colour map itself, so no colour quantisation
// happens on the CPU, and only one byte per pixel is read back instead of four.
// The last palette entry is kept free for transparency (unchanged pixels).
export class GifQuantizer {
  private device!: GPUDevice;
  private pixelCount = 0;
  private colors = 0;
  private levels = 0;
  private colorMode: ColorMode = 'theta2';
  private paramsBuffer!: GPUBuffer;
  private indexBuffer!: GPUBuffer;
  private lutBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;
  private quantizePipeline!: GPUComputePipeline;
  private lutPipeline!: GPUComputePipeline;
  private readonly staging: GPUBuffer[] = [];
  private readonly freeStaging: GPUBuffer[] = [];
  transparentIndex = 0;

  async init(device: GPUDevice, stateBuffer: GPUBuffer, pixelCount: number, opts: GifQuantizerOptions): Promise<void> {
    this.device = device;
    this.pixelCount = pixelCount;
    this.colors = opts.colors;
    this.colorMode = opts.colorMode;
    this.transparentIndex = opts.colors - 1;
    // Flip-time mode also reserves the entry below it for white (never flipped).
    this.levels = opts.colorMode === 'flipTime' ? opts.colors - 2 : opts.colors - 1;

    // Params: count, colorMode, palette, levels, maxFlipTime, whiteIndex + 2 pad = 32 bytes
    const params = new ArrayBuffer(32);
    const u = new Uint32Array(params);
    const f = new Float32Array(params);
    u[0] = pixelCount;
    u[1] = opts.colorMode === 'theta2' ? 0 : 1;
    u[2] = PALETTE_INDEX[opts.palette];
    u[3] = this.levels;
    f[4] = opts.maxFlipTime;
    u[5] = opts.colors - 2;
    this.paramsBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.paramsBuffer, 0, params);

    this.indexBuffer = device.createBuffer({
      size: this.indexBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.lutBuffer = device.createBuffer({
      size: 256 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const module = device.createShaderModule({ code: paletteShaderCode + quantizeShaderCode });
    [this.quantizePipeline, this.lutPipeline] = await Promise.all([
      device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'quantize' } }),
      device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'build_lut' } }),
    ]);

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 1, resource: { buffer: this.paramsBuffer } },
        { binding: 2, resource: { buffer: this.indexBuffer } },
        { binding: 3, resource: { buffer: this.lutBuffer } },
      ],
    });
  }

  // GIF colour table: `colors` RGB triplets.
  async readPalette(): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = this.levels * 4;
    const staging = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = this.device.createCommandEncoder();
    this.dispatch(enc, this.lutPipeline, Math.ceil(this.levels / 64));
    enc.copyBufferToBuffer(this.lutBuffer, 0, staging, 0, bytes);
    this.device.queue.submit([enc.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const lut = new Uint32Array(staging.getMappedRange().slice(0));
    staging.destroy();

    const rgb = new Uint8Array(this.colors * 3);
    lut.forEach((c, i) => rgb.set([c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff], i * 3));
    if (this.colorMode === 'flipTime') rgb.fill(255, (this.colors - 2) * 3, (this.colors - 1) * 3);
    return rgb;
  }

  // Palette indices of the current simulation state, one byte per pixel.
  // Safe to call again before the previous capture resolves.
  async capture(): Promise<ArrayBuffer> {
    const staging = this.freeStaging.pop() ?? this.createStaging();
    const enc = this.device.createCommandEncoder();
    this.dispatch(enc, this.quantizePipeline, Math.ceil(this.indexBytes / 4 / 256));
    enc.copyBufferToBuffer(this.indexBuffer, 0, staging, 0, this.indexBytes);
    this.device.queue.submit([enc.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const indices = staging.getMappedRange().slice(0, this.pixelCount);
    staging.unmap();
    this.freeStaging.push(staging);
    return indices;
  }

  destroy(): void {
    this.paramsBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.lutBuffer?.destroy();
    for (const b of this.staging) b.destroy();
  }

  // Packed index buffer size: a whole number of u32 words.
  private get indexBytes(): number {
    return Math.ceil(this.pixelCount / 4) * 4;
  }

  private createStaging(): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: this.indexBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.staging.push(buffer);
    return buffer;
  }

  private dispatch(enc: GPUCommandEncoder, pipeline: GPUComputePipeline, workgroups: number): void {
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
  }
}
