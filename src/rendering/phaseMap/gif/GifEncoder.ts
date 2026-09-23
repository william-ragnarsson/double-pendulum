import { ByteWriter, writeFrameControl, writeHeader } from './gifFormat';
import type { EncodedGifFrame, GifFrameJob, GifFrameResult } from './gifFrameWorker';

interface Task {
  job: GifFrameJob;
  transfer: Transferable[];
  resolve: () => void;
  reject: (err: unknown) => void;
}

// Parallel GIF encoder: frames are LZW-compressed by a pool of workers as they
// arrive, then stitched together in order.
export class GifEncoder {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Task[] = [];
  private readonly running = new Map<Worker, Task>();
  private readonly frames: GifFrameResult[] = [];
  private readonly minCodeSize: number;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly palette: Uint8Array<ArrayBuffer>,  // RGB triplets, a power of two of them
    private readonly transparentIndex: number,
  ) {
    this.minCodeSize = Math.max(2, Math.log2(palette.length / 3));
    const size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./gifFrameWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<GifFrameResult>) => this.settle(worker, e.data);
      worker.onerror   = (e) => this.settle(worker, new Error(e.message || 'GIF worker failed'));
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  get concurrency(): number {
    return this.workers.length;
  }

  // Queues frame `id` (one palette index per pixel) for compression. Given
  // `prev`, only what changed since then is stored; `reverse` also stores the
  // step back to `prev`, for ping-pong playback. Both buffers are transferred.
  encodeFrame(id: number, cur: ArrayBuffer, prev: ArrayBuffer | null, reverse: boolean): Promise<void> {
    const job: GifFrameJob = {
      id,
      width: this.width,
      height: this.height,
      minCodeSize: this.minCodeSize,
      transparentIndex: this.transparentIndex,
      cur,
      prev,
      reverse,
    };
    return new Promise((resolve, reject) => {
      this.queue.push({ job, transfer: prev ? [cur, prev] : [cur], resolve, reject });
      this.pump();
    });
  }

  // Frames 0 … n-1, then for ping-pong back down through n-2 … 1, so the loop
  // restarting at frame 0 is seamless.
  finish(frameCount: number, fps: number, pingPong: boolean): Blob {
    const sequence: EncodedGifFrame[] = [];
    for (let k = 0; k < frameCount; k++) sequence.push(this.frames[k].forward);
    if (pingPong) {
      for (let k = frameCount - 1; k >= 2; k--) sequence.push(this.frames[k].reverse!);
    }

    const header = new ByteWriter(1024);
    writeHeader(header, this.width, this.height, this.palette);
    const parts: BlobPart[] = [header.toBytes()];
    sequence.forEach((frame, i) => {
      // Delays are whole centiseconds: spread the rounding so the average rate is exact.
      const delay = Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps);
      const control = new ByteWriter(8);
      writeFrameControl(control, delay, frame.transparent ? this.transparentIndex : null);
      parts.push(control.toBytes(), frame.data);
    });
    parts.push(new Uint8Array([0x3b]));  // trailer
    return new Blob(parts, { type: 'image/gif' });
  }

  destroy(): void {
    for (const worker of this.workers) worker.terminate();
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const task = this.queue.shift()!;
      this.running.set(worker, task);
      worker.postMessage(task.job, task.transfer);
    }
  }

  private settle(worker: Worker, result: GifFrameResult | Error): void {
    const task = this.running.get(worker);
    if (!task) return;
    this.running.delete(worker);
    this.idle.push(worker);
    if (result instanceof Error) {
      task.reject(result);
    } else {
      this.frames[result.id] = result;
      task.resolve();
    }
    this.pump();
  }
}
