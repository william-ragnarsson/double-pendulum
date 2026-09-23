// Minimal GIF89a writer: LZW-compressed frames plus the few blocks a looping
// animation needs. Frames are palette indices straight from GifQuantizer.

// Growable byte buffer.
export class ByteWriter {
  private buf: Uint8Array<ArrayBuffer>;
  length = 0;

  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }

  byte(b: number): void {
    if (this.length === this.buf.length) this.grow(1);
    this.buf[this.length++] = b;
  }

  u16(v: number): void {
    this.byte(v & 0xff);
    this.byte((v >> 8) & 0xff);
  }

  bytes(src: ArrayLike<number>): void {
    if (this.length + src.length > this.buf.length) this.grow(src.length);
    this.buf.set(src, this.length);
    this.length += src.length;
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.length);
  }

  private grow(extra: number): void {
    let capacity = this.buf.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
}

const MAX_BITS  = 12;
const MAX_CODES = 1 << MAX_BITS;
const HASH_SIZE = 5003;  // prime, ~80% load at 4096 codes

// Scratch hash tables for the LZW coder, reused across frames.
export interface LzwTables {
  keys: Int32Array;
  codes: Int32Array;
}

export function createLzwTables(): LzwTables {
  return { keys: new Int32Array(HASH_SIZE), codes: new Int32Array(HASH_SIZE) };
}

// "GIF89a", logical screen, global colour table and the NETSCAPE2.0 extension
// that loops the animation forever. `palette` holds RGB triplets, a power of two of them.
export function writeHeader(out: ByteWriter, width: number, height: number, palette: Uint8Array): void {
  out.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  out.u16(width);
  out.u16(height);
  out.byte(0xf0 | (Math.log2(palette.length / 3) - 1));  // global table, 8-bit colour
  out.byte(0);  // background colour index
  out.byte(0);  // pixel aspect ratio: unspecified
  out.bytes(palette);
  out.bytes([0x21, 0xff, 0x0b]);
  out.bytes([...'NETSCAPE2.0'].map(ch => ch.charCodeAt(0)));
  out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);  // loop count 0 = forever
}

// Graphic control extension: delay in 1/100 s, optional transparent index, and
// disposal "leave in place" so a frame only has to carry what changed.
export function writeFrameControl(out: ByteWriter, delayCs: number, transparentIndex: number | null): void {
  out.bytes([0x21, 0xf9, 0x04, (1 << 2) | (transparentIndex === null ? 0 : 1)]);
  out.u16(delayCs);
  out.byte(transparentIndex ?? 0);
  out.byte(0);
}

// Image descriptor + LZW data for a width × height block at (x, y).
export function writeImage(
  out: ByteWriter,
  x: number,
  y: number,
  width: number,
  height: number,
  pixels: Uint8Array,
  minCodeSize: number,
  tables: LzwTables,
): void {
  out.byte(0x2c);
  out.u16(x);
  out.u16(y);
  out.u16(width);
  out.u16(height);
  out.byte(0);  // no local colour table, not interlaced
  writeLzw(out, pixels, minCodeSize, tables);
}

// GIF-flavoured LZW (variable code width, "early change"), using the hashing
// scheme of the classic compress / GIFEncoder coder. Writes the min-code-size
// byte, the data sub-blocks and the block terminator.
function writeLzw(out: ByteWriter, pixels: Uint8Array, minCodeSize: number, { keys, codes }: LzwTables): void {
  const clearCode = 1 << minCodeSize;
  const endCode   = clearCode + 1;
  const initBits  = minCodeSize + 1;

  let bits     = initBits;
  let maxCode  = (1 << bits) - 1;
  let nextCode = clearCode + 2;
  let clearing = false;

  const block = new Uint8Array(255);
  let blockLen = 0;
  let acc      = 0;
  let accBits  = 0;

  const pushByte = (b: number): void => {
    block[blockLen++] = b;
    if (blockLen === 255) {
      out.byte(255);
      out.bytes(block);
      blockLen = 0;
    }
  };

  const emit = (code: number): void => {
    acc |= code << accBits;
    accBits += bits;
    while (accBits >= 8) {
      pushByte(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
    }
    // Widen the code once the next dictionary entry no longer fits; reset after a clear.
    if (clearing) {
      bits = initBits;
      maxCode = (1 << bits) - 1;
      clearing = false;
    } else if (nextCode > maxCode) {
      bits++;
      maxCode = bits === MAX_BITS ? MAX_CODES : (1 << bits) - 1;
    }
  };

  let hashShift = 0;
  for (let f = HASH_SIZE; f < 65536; f *= 2) hashShift++;
  hashShift = 8 - hashShift;

  out.byte(minCodeSize);
  keys.fill(-1);
  emit(clearCode);

  let prefix = pixels[0];
  next: for (let i = 1; i < pixels.length; i++) {
    const c   = pixels[i];
    const key = (c << MAX_BITS) + prefix;
    let h     = (c << hashShift) ^ prefix;

    if (keys[h] === key) {
      prefix = codes[h];
      continue;
    }
    if (keys[h] >= 0) {
      const step = h === 0 ? 1 : HASH_SIZE - h;
      do {
        h -= step;
        if (h < 0) h += HASH_SIZE;
        if (keys[h] === key) {
          prefix = codes[h];
          continue next;
        }
      } while (keys[h] >= 0);
    }

    emit(prefix);
    prefix = c;
    if (nextCode < MAX_CODES) {
      codes[h] = nextCode++;
      keys[h] = key;
    } else {
      keys.fill(-1);
      nextCode = clearCode + 2;
      clearing = true;
      emit(clearCode);
    }
  }

  emit(prefix);
  emit(endCode);
  if (accBits > 0) pushByte(acc & 0xff);
  if (blockLen > 0) {
    out.byte(blockLen);
    out.bytes(block.subarray(0, blockLen));
  }
  out.byte(0);  // block terminator
}
