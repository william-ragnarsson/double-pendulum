import type { ColorMode, Palette, PhaseRegion } from '../../core/types';
import vertShaderCode from './shaders/vert.wgsl';
import fragShaderCode from './shaders/frag.wgsl';
import paletteShaderCode from './shaders/palette.wgsl';

export const PALETTE_INDEX: Record<Palette, number> = {
  rainbow: 0, lsd: 3, shrooms: 6, snow: 5, acid: 4, mdma: 2,
};

export interface RenderOpts {
  colorMode: ColorMode;
  maxFlipTime: number;
  palette: Palette;
}

// GPU render pipeline for the phase map.
// Reads from the backend's state buffer and draws a fullscreen quad.
// Knows nothing about physics or initial conditions.
export class PhaseMapRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private canvasFormat!: GPUTextureFormat;
  private pipeline!: GPURenderPipeline;
  private renderUniformBuffer!: GPUBuffer;
  private viewUniformBuffer!: GPUBuffer;   // 16 bytes: 4×f32 region bounds
  private bindGroupLayout!: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;
  private width = 0;
  private height = 0;

  async init(device: GPUDevice, canvas: HTMLCanvasElement): Promise<void> {
    this.device = device;
    this.width = canvas.width;
    this.height = canvas.height;

    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.canvasFormat, alphaMode: 'opaque' });

    // Render uniforms: width, height, colorMode, maxFlipTime, palette, pad×3 = 32 bytes
    this.renderUniformBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // View region: theta1Min, theta1Max, theta2Min, theta2Max = 16 bytes
    this.viewUniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    const vertModule = device.createShaderModule({ code: vertShaderCode });
    const fragModule = device.createShaderModule({ code: paletteShaderCode + fragShaderCode });

    this.pipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex:   { module: vertModule, entryPoint: 'vs_main' },
      fragment: {
        module: fragModule, entryPoint: 'fs_main',
        targets: [{ format: this.canvasFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  // Call after changing canvas dimensions (resolution change).
  reconfigure(canvas: HTMLCanvasElement): void {
    this.width  = canvas.width;
    this.height = canvas.height;
    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.context.configure({ device: this.device, format: this.canvasFormat, alphaMode: 'opaque' });
    this.bindGroup = null;
  }

  // Call once after backend.init() and again after every backend.reinitialize().
  setStateBuffer(stateBuffer: GPUBuffer): void {
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 1, resource: { buffer: this.renderUniformBuffer } },
        { binding: 2, resource: { buffer: this.viewUniformBuffer } },
      ],
    });
  }

  setView(region: PhaseRegion): void {
    const buf = new Float32Array(4);
    buf[0] = region.theta1Min;  buf[1] = region.theta1Max;
    buf[2] = region.theta2Min;  buf[3] = region.theta2Max;
    this.device.queue.writeBuffer(this.viewUniformBuffer, 0, buf);
  }

  render(opts: RenderOpts): void {
    if (!this.bindGroup) return;

    const buf = new ArrayBuffer(32);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = this.width;
    u[1] = this.height;
    u[2] = opts.colorMode === 'theta2' ? 0 : 1;
    f[3] = opts.maxFlipTime;
    u[4] = PALETTE_INDEX[opts.palette];
    this.device.queue.writeBuffer(this.renderUniformBuffer, 0, buf);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6);  // 2 triangles = fullscreen quad
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.renderUniformBuffer.destroy();
    this.viewUniformBuffer.destroy();
  }
}
