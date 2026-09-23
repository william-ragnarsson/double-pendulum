// Requires palette.wgsl, prepended by PhaseMapRenderer.

struct RenderParams {
  width:       u32,   // canvas pixel width
  height:      u32,   // canvas pixel height
  colorMode:   u32,   // 0 = live theta2, 1 = flip-time
  maxFlipTime: f32,
  palette:     u32,   // 0=rainbow,1=fire,2=jet,3=neon,4=acid,5=gray,6=twilight
  _pad:        u32,
  _pad2:       u32,
  _pad3:       u32,
}

struct ViewRegion {
  theta1Min: f32,  theta1Max: f32,
  theta2Min: f32,  theta2Max: f32,
}

@group(0) @binding(0) var<storage, read> states: array<f32>;
@group(0) @binding(1) var<uniform> params: RenderParams;
@group(0) @binding(2) var<uniform> vr: ViewRegion;

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let px = u32(fragCoord.x);
  let py = u32(fragCoord.y);

  // Pixel → angle
  let t1 = vr.theta1Min + f32(px) / f32(params.width  - 1u) * (vr.theta1Max - vr.theta1Min);
  let t2 = vr.theta2Max - f32(py) / f32(params.height - 1u) * (vr.theta2Max - vr.theta2Min);

  // Angle → buffer index
  let span1 = vr.theta1Max - vr.theta1Min;
  let span2 = vr.theta2Max - vr.theta2Min;
  let ci  = u32(clamp((t1 - vr.theta1Min) / span1 * f32(params.width),  0.0, f32(params.width  - 1u)));
  let cj  = u32(clamp((vr.theta2Max - t2) / span2 * f32(params.height), 0.0, f32(params.height - 1u)));
  let idx  = cj * params.width + ci;
  let base = idx * 8u;

  if params.colorMode == 0u {
    // Live theta2 mode: map current angle to palette (cyclic)
    let theta2 = states[base + 2u];
    let t = fract(theta2 / TWO_PI + 2.0);  // +2 ensures positive before fract
    return vec4f(palette_cyc(t, params.palette), 1.0);
  } else {
    // Flip-time mode: white = never flipped (stable), palette = time until first flip
    let ft = states[base + 5u];
    if ft < 0.0 {
      return vec4f(1.0, 1.0, 1.0, 1.0);  // stable region = white
    }
    let t = clamp(ft / params.maxFlipTime, 0.0, 1.0);
    return vec4f(palette_seq(t, params.palette), 1.0);
  }
}
