import { ByteWriter, createLzwTables, writeImage } from './gifFormat';

export interface GifFrameJob {
  id: number;
  width: number;
  height: number;
  minCodeSize: number;
  transparentIndex: number;
  cur: ArrayBuffer;           // palette indices, width × height
  prev: ArrayBuffer | null;   // previous frame's indices; null → encode the full frame
  reverse: boolean;           // also encode the step back from cur to prev (ping-pong)
}

export interface EncodedGifFrame {
  data: Uint8Array<ArrayBuffer>;  // image descriptor + LZW data
  transparent: boolean;           // unchanged pixels use the transparent index
}

export interface GifFrameResult {
  id: number;
  forward: EncodedGifFrame;
  reverse: EncodedGifFrame | null;
}

const tables = createLzwTables();

self.onmessage = (e: MessageEvent<GifFrameJob>) => {
  const job  = e.data;
  const cur  = new Uint8Array(job.cur);
  const prev = job.prev && new Uint8Array(job.prev);

  const forward = prev
    ? encodeUpdate(job, cur, prev)
    : encodeBlock(job, 0, 0, job.width, job.height, cur, false);
  const reverse = prev && job.reverse ? encodeUpdate(job, prev, cur) : null;

  const result: GifFrameResult = { id: job.id, forward, reverse };
  const transfer = reverse ? [forward.data.buffer, reverse.data.buffer] : [forward.data.buffer];
  self.postMessage(result, { transfer });
};

// Encodes `next` as an update over `shown`, the frame currently on screen:
// only the bounding box of changed pixels, with unchanged pixels either marked
// transparent or repeated as-is, whichever compresses smaller.
function encodeUpdate(job: GifFrameJob, next: Uint8Array, shown: Uint8Array): EncodedGifFrame {
  const { width, height, transparentIndex } = job;
  let x0 = width, x1 = -1, y0 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (next[row + x] !== shown[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y0 < 0) y0 = y;
        y1 = y;
      }
    }
  }
  // Nothing changed: a single transparent pixel still carries the frame delay.
  if (x1 < 0) return encodeBlock(job, 0, 0, 1, 1, Uint8Array.of(transparentIndex), true);

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const plain  = new Uint8Array(w * h);
  const masked = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (y0 + y) * width + x0;
    const dst = y * w;
    for (let x = 0; x < w; x++) {
      const v = next[src + x];
      plain[dst + x]  = v;
      masked[dst + x] = v === shown[src + x] ? transparentIndex : v;
    }
  }
  const withTransparency = encodeBlock(job, x0, y0, w, h, masked, true);
  const opaque           = encodeBlock(job, x0, y0, w, h, plain, false);
  return withTransparency.data.length <= opaque.data.length ? withTransparency : opaque;
}

function encodeBlock(
  job: GifFrameJob,
  x: number,
  y: number,
  w: number,
  h: number,
  pixels: Uint8Array,
  transparent: boolean,
): EncodedGifFrame {
  const out = new ByteWriter(w * h);
  writeImage(out, x, y, w, h, pixels, job.minCodeSize, tables);
  return { data: out.toBytes(), transparent };
}
