import posthog from '../analytics';
import { PhaseMapBackend } from '../rendering/phaseMap/PhaseMapBackend';
import { PhaseMapRenderer } from '../rendering/phaseMap/PhaseMapRenderer';
import { PendulumCanvas } from '../rendering/pendulumCanvas';
import { PhaseCanvas } from '../rendering/phaseCanvas';
import { observeCanvasSize } from '../rendering/canvasResize';
import { DEFAULT_PHYSICS, DEFAULT_SIM } from '../core/config';
import type { ColorMode, Palette, PhaseRegion, PendulumState, PhysicsParams, View } from '../core/types';

export class PhaseMapView implements View {
  private backend!: PhaseMapBackend;
  private renderer!: PhaseMapRenderer;
  private ready = false;
  private rafId = 0;

  private readonly region: PhaseRegion = {
    theta1Min: -Math.PI, theta1Max: Math.PI,
    theta2Min: -Math.PI, theta2Max: Math.PI,
  };
  private colorMode: ColorMode = 'theta2';
  private palette: Palette = 'rainbow';
  private stepsPerDispatch = 10;
  private maxFlipTime = 50;
  private gridRes = 800;
  private physics: PhysicsParams = { ...DEFAULT_PHYSICS };

  paused = true;

  // Probe state
  private readonly probePendulumCanvas: PendulumCanvas;
  private readonly probePhaseCanvas: PhaseCanvas;
  private readonly probePendulumEl: HTMLCanvasElement;
  private readonly probePhaseEl: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver;
  private stagingBuffer!: GPUBuffer;
  private probeIndex: number | null = null;
  private probeState: PendulumState | null = null;
  private readInFlight = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GPUDevice,
    probePendulumEl: HTMLCanvasElement,
    probePhaseEl: HTMLCanvasElement,
  ) {
    this.probePendulumEl     = probePendulumEl;
    this.probePhaseEl        = probePhaseEl;
    this.probePendulumCanvas = new PendulumCanvas(probePendulumEl);
    this.probePhaseCanvas    = new PhaseCanvas(probePhaseEl);
    this.resizeObserver = observeCanvasSize(probePendulumEl, probePhaseEl);
  }

  async initGPU(): Promise<void> {
    this.canvas.width  = this.gridRes;
    this.canvas.height = this.gridRes;
    this.backend  = new PhaseMapBackend();
    this.renderer = new PhaseMapRenderer();
    await this.backend.init(this.device, this.gridRes, this.gridRes, this.region);
    await this.renderer.init(this.device, this.canvas);
    this.renderer.setStateBuffer(this.backend.getStateBuffer());
    this.renderer.setView(this.region);

    this.stagingBuffer = this.device.createBuffer({
      size: 8 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.ready = true;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  activate(): void {
    this.canvas.addEventListener('click', this.onClick);
    this.loop();
  }

  deactivate(): void {
    cancelAnimationFrame(this.rafId);
    this.canvas.removeEventListener('click', this.onClick);
  }

  destroy(): void {
    this.deactivate();
    this.backend?.destroy();
    this.renderer?.destroy();
    this.stagingBuffer?.destroy();
    this.resizeObserver.disconnect();
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  setColorMode(mode: ColorMode): void { this.colorMode = mode; }
  setPalette(p: Palette): void { this.palette = p; }
  setStepsPerDispatch(n: number): void { this.stepsPerDispatch = n; }
  getRegion(): PhaseRegion { return { ...this.region }; }
  getPhysics(): PhysicsParams { return { ...this.physics }; }

  setPhysics(p: PhysicsParams): void {
    this.physics = { ...p };
    this.backend?.reinitialize(this.region);
    this.resetProbe();
  }

  async changeResolution(n: number): Promise<void> {
    this.ready = false;
    this.gridRes = n;
    this.backend.destroy();
    this.canvas.width  = n;
    this.canvas.height = n;
    this.renderer.reconfigure(this.canvas);
    this.backend = new PhaseMapBackend();
    await this.backend.init(this.device, n, n, this.region);
    this.renderer.setStateBuffer(this.backend.getStateBuffer());
    this.renderer.setView(this.region);
    this.probeIndex = null;
    this.probeState = null;
    this.ready = true;
  }

  reset(): void {
    if (this.backend) this.backend.reinitialize(this.region);
    this.resetProbe();
  }

  resetProbe(): void {
    this.probeIndex = null;
    this.probeState = null;
    this.probePhaseCanvas.reset(1);
  }

  // ── RAF loop ──────────────────────────────────────────────────────────────

  private loop(): void {
    if (this.ready) {
      if (!this.paused) {
        const freeze = this.colorMode === 'flipTime';
        this.backend.step(this.physics, DEFAULT_SIM.dt, this.stepsPerDispatch, freeze);
      }
      this.renderer.render({ colorMode: this.colorMode, maxFlipTime: this.maxFlipTime, palette: this.palette });
      this.fetchProbeState();
    }

    if (this.probeState) {
      this.probePendulumCanvas.draw([this.probeState], this.physics.L1, this.physics.L2, 'all');
      this.probePhaseCanvas.addPoints([this.probeState]);
      this.probePhaseCanvas.draw([this.probeState], 'all');
    } else {
      this.drawProbePlaceholder();
    }

    this.rafId = requestAnimationFrame(() => this.loop());
  }

  private drawProbePlaceholder(): void {
    for (const el of [this.probePendulumEl, this.probePhaseEl]) {
      const ctx = el.getContext('2d')!;
      const { width: w, height: h } = el;
      ctx.clearRect(0, 0, w, h);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText('→', w / 2, h / 2 - 18);
      ctx.font = '12px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText('click map to probe', w / 2, h / 2 + 10);
    }
  }

  // ── Probe ─────────────────────────────────────────────────────────────────

  private onClick = (e: MouseEvent): void => {
    this.probe(e.clientX, e.clientY);
  };

  private probe(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const i = Math.round(((clientX - rect.left) / rect.width)  * (this.gridRes - 1));
    const j = Math.round(((clientY - rect.top)  / rect.height) * (this.gridRes - 1));
    this.probeIndex = j * this.gridRes + i;
    this.probeState = null;
    this.probePhaseCanvas.reset(1);
    const theta1 = this.region.theta1Min + (i / (this.gridRes - 1)) * (this.region.theta1Max - this.region.theta1Min);
    const theta2 = this.region.theta2Max - (j / (this.gridRes - 1)) * (this.region.theta2Max - this.region.theta2Min);
    posthog.capture('phase map probe clicked', { theta1: Math.round(theta1 * 1000) / 1000, theta2: Math.round(theta2 * 1000) / 1000 });
  }

  private fetchProbeState(): void {
    if (this.readInFlight || this.probeIndex === null) return;
    this.readInFlight = true;
    void this.doFetch(this.probeIndex);
  }

  private async doFetch(index: number): Promise<void> {
    try {
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(this.backend.getStateBuffer(), index * 32, this.stagingBuffer, 0, 32);
      this.device.queue.submit([enc.finish()]);
      await this.stagingBuffer.mapAsync(GPUMapMode.READ, 0, 32);
      const f = new Float32Array(this.stagingBuffer.getMappedRange(0, 32));
      this.probeState = { theta1: f[0], omega1: f[1], theta2: f[2], omega2: f[3] };
      this.stagingBuffer.unmap();
    } catch {
      // GPU error or buffer contention — ignore, retry next frame
    } finally {
      this.readInFlight = false;
    }
  }
}
