# Double Pendulum

An interactive browser-based simulation that makes the chaotic behaviour of a double pendulum intuitive and explorable, not just a textbook curiosity.

## Live Demo

**[pendulum.williamragnarsson.com](https://www.pendulum.williamragnarsson.com)**

The site includes a *How It Works* tab that goes deep on the equations of motion, Lagrangian mechanics, and the numerics. This README focuses on the code instead.

## What it does

Three views, one app:

- **Pendulum**: simulate up to 50 pendulums with tiny differences in initial angle and watch them diverge. Drag to set starting conditions; live phase portraits and time-series plots update alongside the animation.
- **Phase Map**: a GPU-rendered 2D slice of the 4D phase space (θ₁ × θ₂), coloured by final angle or *flip time* (how quickly chaos sets in). Click any point to probe its trajectory. Export it as a high-res PNG, an MP4/WebM video or a looping GIF.
- **Technical**: embedded walkthrough of the physics and numerics, rendered with KaTeX.

## Tech stack

- **TypeScript** + **Vite**
- **Canvas 2D**: pendulum animation, phase portraits, time-series plots
- **WebGPU + WGSL shaders**: parallel RK4 integration across the entire phase map grid, rendered via a custom compute → fragment pipeline
- **WebCodecs + [Mediabunny](https://mediabunny.dev)**: hardware video encoding and MP4/WebM muxing for animation export; GIFs are LZW-encoded in Web Workers
- **KaTeX**: equation rendering in the Technical tab

## Architecture

```
src/
├── core/           # Types, default config, math utilities
├── physics/        # RK4 integrator (equations.ts) + Simulation state manager
├── rendering/
│   ├── *.ts        # Canvas 2D renderers (pendulum, phase portrait, time series)
│   └── phaseMap/   # WebGPU pipeline: compute shaders, renderer, PNG/video/GIF exporters
├── views/          # PendulumView and PhaseMapView (top-level controllers)
└── tutorial/       # First-run guided hints
```

The physics lives entirely in `src/physics/equations.ts`: `derivatives()` evaluates the coupled ODEs and `rk4Step()` advances the state. The WebGPU path in `src/rendering/phaseMap/` runs the same integration in parallel across hundreds of thousands of initial conditions using `compute.wgsl`.

## Running locally

```bash
npm install
npm run dev
```

WebGPU is required. Chrome 113+ or Edge 113+ recommended.
