// GIF quantizer: maps each pendulum straight to a palette index (one byte per
// pixel, four packed per u32) and builds the matching palette from the same
// colour maps the renderer uses. Requires palette.wgsl, prepended by GifQuantizer.

struct QuantParams {
  count:       u32,  // pendulums (= pixels)
  colorMode:   u32,  // 0 = live theta2 (cyclic), 1 = flip-time (sequential)
  palette:     u32,
  levels:      u32,  // colour-map entries, indices 0 … levels-1
  maxFlipTime: f32,
  whiteIndex:  u32,  // flip-time mode: never flipped
  _pad0:       u32,
  _pad1:       u32,
}

@group(0) @binding(0) var<storage, read> states: array<f32>;
@group(0) @binding(1) var<uniform> qp: QuantParams;
@group(0) @binding(2) var<storage, read_write> indices: array<u32>;
@group(0) @binding(3) var<storage, read_write> lut: array<u32>;

// Nearest colour-map entry — same value → colour mapping as frag.wgsl.
fn palette_index(i: u32) -> u32 {
  let base = i * 8u;
  if qp.colorMode == 0u {
    let t = fract(states[base + 2u] / TWO_PI + 2.0);
    return u32(round(t * f32(qp.levels))) % qp.levels;
  }
  let ft = states[base + 5u];
  if ft < 0.0 { return qp.whiteIndex; }
  let t = clamp(ft / qp.maxFlipTime, 0.0, 1.0);
  return u32(round(t * f32(qp.levels - 1u)));
}

@compute @workgroup_size(256)
fn quantize(@builtin(global_invocation_id) gid: vec3u) {
  let first = gid.x * 4u;
  if first >= qp.count { return; }
  var packed = 0u;
  for (var b = 0u; b < 4u; b++) {
    if first + b < qp.count {
      packed |= palette_index(first + b) << (8u * b);
    }
  }
  indices[gid.x] = packed;
}

// Colour-map entry i as 0x00BBGGRR, rounded the way an 8-bit render target would.
@compute @workgroup_size(64)
fn build_lut(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if i >= qp.levels { return; }
  var c: vec3f;
  if qp.colorMode == 0u {
    c = palette_cyc(f32(i) / f32(qp.levels), qp.palette);
  } else {
    c = palette_seq(f32(i) / f32(qp.levels - 1u), qp.palette);
  }
  let q = vec3u(round(clamp(c, vec3f(0.0), vec3f(1.0)) * 255.0));
  lut[i] = q.r | (q.g << 8u) | (q.b << 16u);
}
