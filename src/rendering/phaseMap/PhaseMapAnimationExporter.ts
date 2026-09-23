import { PhaseMapBackend } from './PhaseMapBackend';
import { PhaseMapRenderer, type RenderOpts } from './PhaseMapRenderer';
import { FrameStore } from './FrameStore';
import { GifQuantizer } from './GifQuantizer';
import { GifEncoder } from './gif/GifEncoder';
import { DEFAULT_SIM } from '../../core/config';
import type { ColorMode, Palette, PhaseRegion, PhysicsParams } from '../../core/types';

// Physics work per compute dispatch (pixels × RK4 steps), so no single
// dispatch runs long enough to trip a GPU watchdog at large resolutions.
const PIXEL_STEPS_PER_DISPATCH = 32_000_000;
const MAX_STEPS_PER_DISPATCH   = 50;
const PREVIEW_INTERVAL         = 4;   // frames between preview updates
const STATE_BYTES_PER_PIXEL    = 32;  // PhaseMapBackend: 8 × f32 per pendulum
const MAX_VIDEO_BITRATE        = 120_000_000;
const MAX_PINGPONG_BYTES       = 1.5 * 2 ** 30;  // frames held in memory for the way back

// Video bits per pixel per frame. Chaotic regions are per-pixel noise, which
// codecs only keep at far higher rates than camera footage needs; below
// ~0.25 they smear it into grey blocks.
const VIDEO_BITS_PER_PIXEL = { standard: 0.25, high: 0.6, 'very-high': 1.2 };

export type AnimationFormat = 'mp4' | 'webm' | 'gif';
export type VideoQuality    = 'standard' | 'high' | 'very-high';

export interface AnimationTiming {
  simSeconds: number;     // physics time covered by the animation
  lengthSeconds: number;  // playback length of the file
  fps: number;
  pingPong: boolean;      // play forward, then backward, so the loop is seamless
}

export interface AnimationExportOptions extends AnimationTiming {
  format: AnimationFormat;
  resolution: number;
  quality: VideoQuality;  // video only
  gifColors: number;      // GIF only: palette size, a power of two ≤ 256
  colorMode: ColorMode;
  palette: Palette;
  region: PhaseRegion;
  physics: PhysicsParams;
  maxFlipTime: number;
  previewCanvas: HTMLCanvasElement;
  onProgress: (fraction: number, label: string) => void;
}

export type AnimationExportResult =
  | { status: 'done'; filename: string; bytes: number }
  | { status: 'cancelled' };

export interface FramePlan {
  frames: number;         // distinct simulation frames rendered
  stepsPerFrame: number;  // RK4 steps between consecutive frames
  outputFrames: number;   // frames in the file (ping-pong replays them backwards)
}

export function planFrames(t: AnimationTiming): FramePlan {
  const total  = Math.max(2, Math.round(t.lengthSeconds * t.fps));
  const frames = t.pingPong ? Math.floor(total / 2) + 1 : total;
  const stepsPerFrame = Math.max(1, Math.round(t.simSeconds / DEFAULT_SIM.dt / (frames - 1)));
  return {
    frames,
    stepsPerFrame,
    outputFrames: t.pingPong ? 2 * frames - 2 : frames,
  };
}

export function videoBitrate(resolution: number, fps: number, quality: VideoQuality): number {
  return Math.min(MAX_VIDEO_BITRATE, Math.round(resolution * resolution * fps * VIDEO_BITS_PER_PIXEL[quality]));
}

// Largest square animation whose state fits in a single GPU buffer.
export function maxAnimationResolution(device: GPUDevice): number {
  const { maxStorageBufferBindingSize, maxBufferSize, maxComputeWorkgroupsPerDimension } = device.limits;
  const maxPixels = Math.min(
    Math.min(maxStorageBufferBindingSize, maxBufferSize) / STATE_BYTES_PER_PIXEL,
    maxComputeWorkgroupsPerDimension * 256,
  );
  return Math.floor(Math.sqrt(maxPixels));
}

// Records the phase map evolving over time as a video (MP4/WebM through
// WebCodecs) or a looping GIF. Video frames never leave the GPU: each one is
// simulated, rendered to a canvas and handed to the hardware encoder as a
// VideoFrame (ping-pong also keeps a 16-bit copy for the way back). GIF frames
// come back as one palette index per pixel and are LZW-compressed in parallel
// workers.
export class PhaseMapAnimationExporter {
  private cancelled = false;

  cancel(): void { this.cancelled = true; }

  async run(device: GPUDevice, opts: AnimationExportOptions): Promise<AnimationExportResult> {
    const { resolution } = opts;
    const plan = planFrames(opts);
    const canvas = document.createElement('canvas');
    canvas.width  = resolution;
    canvas.height = resolution;

    const backend  = new PhaseMapBackend();
    const renderer = new PhaseMapRenderer();
    try {
      await backend.init(device, resolution, resolution, opts.region);
      await renderer.init(device, canvas);
      renderer.setStateBuffer(backend.getStateBuffer());
      renderer.setView(opts.region);

      const frames = new FrameSource(backend, renderer, canvas, plan, opts);
      const file = opts.format === 'gif'
        ? await this.encodeGif(device, frames, backend.getStateBuffer())
        : await this.encodeVideo(device, frames, backend.getStateBuffer());
      if (!file) return { status: 'cancelled' };

      const filename = `phasemap_${resolution}px_${opts.fps}fps${opts.pingPong ? '_pingpong' : ''}.${opts.format}`;
      const url = URL.createObjectURL(file);
      Object.assign(document.createElement('a'), { href: url, download: filename }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return { status: 'done', filename, bytes: file.size };
    } finally {
      backend.destroy();
      renderer.destroy();
    }
  }

  // ── Video ─────────────────────────────────────────────────────────────────

  private async encodeVideo(device: GPUDevice, frames: FrameSource, stateBuffer: GPUBuffer): Promise<Blob | null> {
    const { opts, plan } = frames;
    const pixels = opts.resolution * opts.resolution;
    // Ping-pong replays frames 1 … n-2 backwards, so those are kept in memory.
    const storedBytes = opts.pingPong ? (plan.frames - 2) * FrameStore.bytesPerFrame(pixels) : 0;
    if (storedBytes > MAX_PINGPONG_BYTES) {
      throw new Error(`ping-pong at this size needs ${(storedBytes / 2 ** 30).toFixed(1)} GB of memory; try a shorter or smaller video`);
    }

    const mb = await import('./videoMuxing');
    const quality = new mb.Quality({ bitrate: videoBitrate(opts.resolution, opts.fps, opts.quality) });
    const isMp4 = opts.format === 'mp4';
    // H.264 first for MP4: it plays everywhere, social platforms included.
    const codec = await mb.getFirstEncodableVideoCodec(isMp4 ? ['avc', 'hevc', 'av1', 'vp9'] : ['vp9', 'av1', 'vp8'], {
      width: opts.resolution, height: opts.resolution, quality, frameRate: opts.fps,
    });
    if (!codec) {
      throw new Error(`this browser can't encode ${opts.resolution}×${opts.resolution} ${opts.format.toUpperCase()} video`);
    }

    const output = new mb.Output({
      format: isMp4 ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat(),
      target: new mb.BufferTarget(),
    });
    const source = new mb.CanvasSource(frames.canvas, { codec, quality });
    output.addVideoTrack(source, { frameRate: opts.fps });

    const store = opts.pingPong ? new FrameStore() : null;
    const frameDuration = 1 / opts.fps;
    let written = 0;
    // Encodes the canvas as the next frame of the file.
    const addFrame = async (): Promise<void> => {
      await source.add(written * frameDuration, frameDuration);  // snapshots the canvas synchronously
      written++;
      opts.onProgress((written / plan.outputFrames) * 0.97, `Frame ${written} / ${plan.outputFrames}  ·  ${codec.toUpperCase()}`);
    };

    try {
      await store?.init(device, stateBuffer, pixels, opts.colorMode, opts.maxFlipTime);
      await output.start();

      const saved: (Promise<ArrayBuffer> | undefined)[] = [];
      for (let k = 0; k < plan.frames; k++) {
        if (this.cancelled) return null;
        frames.advanceTo(k);
        frames.render(k);
        if (store && k >= 1 && k <= plan.frames - 2) {
          const frame = store.save();
          frame.catch(() => {});  // surfaces when awaited; silences aborts on cancel
          saved[k] = frame;
        }
        await addFrame();
      }
      if (store) {
        for (let k = plan.frames - 2; k >= 1; k--) {
          if (this.cancelled) return null;
          store.restore(await saved[k]!);
          saved[k] = undefined;
          frames.render(written);
          await addFrame();
        }
      }

      opts.onProgress(0.98, 'Finishing encode…');
      source.close();
      await output.finalize();
      return new Blob([output.target.buffer!], { type: output.format.mimeType });
    } finally {
      if (output.state === 'pending' || output.state === 'started') await output.cancel();
      store?.destroy();
    }
  }

  // ── GIF ───────────────────────────────────────────────────────────────────

  private async encodeGif(device: GPUDevice, frames: FrameSource, stateBuffer: GPUBuffer): Promise<Blob | null> {
    const { opts, plan } = frames;
    const quantizer = new GifQuantizer();
    try {
      await quantizer.init(device, stateBuffer, opts.resolution * opts.resolution, {
        colorMode: opts.colorMode, palette: opts.palette, maxFlipTime: opts.maxFlipTime, colors: opts.gifColors,
      });
      const gif = new GifEncoder(opts.resolution, opts.resolution, await quantizer.readPalette(), quantizer.transparentIndex);
      try {
        // GPU readbacks and compression run ahead of the loop. Each frame's
        // buffer is handed to a worker, so a copy is kept as the next frame's `prev`.
        const inFlight: Promise<void>[] = [];
        let prev: Promise<ArrayBuffer | null> = Promise.resolve(null);
        let encoded = 0;
        let failure: unknown = null;

        for (let k = 0; k < plan.frames; k++) {
          if (this.cancelled) return null;
          if (failure) throw failure;
          frames.advanceTo(k);
          if (k % PREVIEW_INTERVAL === 0) frames.render(k);

          const captured = quantizer.capture().then(cur => ({ cur, copy: cur.slice(0) }));
          const frame = Promise.all([captured, prev])
            .then(([{ cur }, prevIndices]) => gif.encodeFrame(k, cur, prevIndices, opts.pingPong && k >= 2))
            .then(() => {
              encoded++;
              opts.onProgress((encoded / plan.frames) * 0.95, `Frame ${encoded} / ${plan.frames}`);
            });
          frame.catch(err => { failure ??= err; });
          prev = captured.then(c => c.copy, () => null);
          inFlight.push(frame);
          // Bound memory: a few frames queued per worker at most.
          if (inFlight.length >= gif.concurrency * 3) await inFlight.shift();
        }
        await Promise.all(inFlight);

        opts.onProgress(0.98, 'Writing GIF…');
        return gif.finish(plan.frames, opts.fps, opts.pingPong);
      } finally {
        gif.destroy();
      }
    } finally {
      quantizer.destroy();
    }
  }
}

// Steps the export simulation frame by frame and renders it for the encoder
// and the progress preview.
class FrameSource {
  private readonly stepsPerDispatch: number;
  private readonly renderOpts: RenderOpts;

  constructor(
    private readonly backend: PhaseMapBackend,
    private readonly renderer: PhaseMapRenderer,
    readonly canvas: HTMLCanvasElement,
    readonly plan: FramePlan,
    readonly opts: AnimationExportOptions,
  ) {
    const pixels = opts.resolution * opts.resolution;
    this.stepsPerDispatch = Math.max(1, Math.min(MAX_STEPS_PER_DISPATCH, Math.floor(PIXEL_STEPS_PER_DISPATCH / pixels)));
    this.renderOpts = { colorMode: opts.colorMode, palette: opts.palette, maxFlipTime: opts.maxFlipTime };
  }

  // Frame 0 is the initial state; each later frame advances stepsPerFrame RK4 steps.
  advanceTo(frame: number): void {
    if (frame === 0) return;
    const freeze = this.opts.colorMode === 'flipTime';
    for (let done = 0; done < this.plan.stepsPerFrame; done += this.stepsPerDispatch) {
      const steps = Math.min(this.stepsPerDispatch, this.plan.stepsPerFrame - done);
      this.backend.step(this.opts.physics, DEFAULT_SIM.dt, steps, freeze);
    }
  }

  // Renders the current state to the canvas, mirroring every few frames into the preview.
  render(frame: number): void {
    this.renderer.render(this.renderOpts);
    if (frame % PREVIEW_INTERVAL === 0) {
      const preview = this.opts.previewCanvas;
      preview.getContext('2d')!.drawImage(this.canvas, 0, 0, preview.width, preview.height);
    }
  }
}
