// Frame store for ping-pong video: packs the value each pixel is coloured by
// (θ₂ or flip time) into 16 bits, and later writes it back into the state
// buffer so the renderer can draw that frame again.

const TWO_PI: f32 = 6.28318530717959;
const NEVER:  u32 = 0xffffu;  // flip-time mode: never flipped

struct StoreParams {
  count:       u32,  // pendulums (= pixels)
  colorMode:   u32,  // 0 = live theta2, 1 = flip-time
  maxFlipTime: f32,
  _pad:        u32,
}

@group(0) @binding(0) var<storage, read_write> states: array<f32>;
@group(0) @binding(1) var<uniform> sp: StoreParams;
@group(0) @binding(2) var<storage, read_write> packed: array<u32>;

fn encode(i: u32) -> u32 {
  let base = i * 8u;
  if sp.colorMode == 0u {
    return u32(round(fract(states[base + 2u] / TWO_PI + 2.0) * 65535.0));
  }
  let ft = states[base + 5u];
  if ft < 0.0 { return NEVER; }
  return u32(round(clamp(ft / sp.maxFlipTime, 0.0, 1.0) * 65534.0));
}

fn decode(i: u32, v: u32) {
  let base = i * 8u;
  if sp.colorMode == 0u {
    states[base + 2u] = f32(v) / 65535.0 * TWO_PI;
  } else {
    states[base + 5u] = select(f32(v) / 65534.0 * sp.maxFlipTime, -1.0, v == NEVER);
  }
}

@compute @workgroup_size(256)
fn pack(@builtin(global_invocation_id) gid: vec3u) {
  let first = gid.x * 2u;
  if first >= sp.count { return; }
  var word = encode(first);
  if first + 1u < sp.count { word |= encode(first + 1u) << 16u; }
  packed[gid.x] = word;
}

@compute @workgroup_size(256)
fn unpack(@builtin(global_invocation_id) gid: vec3u) {
  let first = gid.x * 2u;
  if first >= sp.count { return; }
  let word = packed[gid.x];
  decode(first, word & 0xffffu);
  if first + 1u < sp.count { decode(first + 1u, word >> 16u); }
}
