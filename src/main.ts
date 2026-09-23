import { inject } from '@vercel/analytics';
import posthog from './analytics';
import { PendulumView } from './views/PendulumView';
import { PhaseMapView } from './views/PhaseMapView';
import { PhaseMapExporter } from './rendering/phaseMap/PhaseMapExporter';
import {
  PhaseMapAnimationExporter, maxAnimationResolution, planFrames, videoBitrate,
  type AnimationFormat, type AnimationTiming, type VideoQuality,
} from './rendering/phaseMap/PhaseMapAnimationExporter';
import { getGPUDevice } from './rendering/device';
import { DEFAULT_PHYSICS, DEFAULT_SIM } from './core/config';
import type { ColorMode, Palette } from './core/types';

const SVG_PLAY  = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
const SVG_PAUSE = `<svg width="10" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;

let toastTimer = 0;
function showToast(msg: string, durationMs = 3000): void {
  const el = document.getElementById('toast')!;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('visible'), durationMs);
}

function formatBytes(bytes: number): string {
  return bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

async function init(): Promise<void> {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const tabPendulum  = document.getElementById('tab-pendulum')    as HTMLButtonElement;
  const tabPhasemap  = document.getElementById('tab-phasemap')    as HTMLButtonElement;
  const tabTech      = document.getElementById('tab-tech')        as HTMLButtonElement;
  const app          = document.getElementById('app')             as HTMLElement;
  const pagePendulum = document.getElementById('page-pendulum')   as HTMLElement;
  const pagePhasemap = document.getElementById('page-phasemap')   as HTMLElement;
  const pageTech     = document.getElementById('page-tech')       as HTMLElement;

  // Pendulum page controls
  const numPendulumsInput   = document.getElementById('numPendulums')        as HTMLInputElement;
  const deltaAngleInput     = document.getElementById('deltaAngle')          as HTMLInputElement;
  const playPauseBtn        = document.getElementById('playPauseBtn')        as HTMLButtonElement;
  const resetBtn            = document.getElementById('resetBtn')            as HTMLButtonElement;
  const showSelectContainer = document.getElementById('showSelectContainer') as HTMLElement;
  const speedRange          = document.getElementById('speed')               as HTMLInputElement;
  const speedLabel          = document.getElementById('speedLabel')          as HTMLSpanElement;
  const angleTheta1Input    = document.getElementById('angle-theta1')        as HTMLInputElement;
  const angleTheta2Input    = document.getElementById('angle-theta2')        as HTMLInputElement;

  // Pendulum canvases
  const pendCanvasEl  = document.getElementById('canvas-pendulum') as HTMLCanvasElement;
  const phaseCanvasEl = document.getElementById('canvas-phase')    as HTMLCanvasElement;
  const t1CanvasEl    = document.getElementById('canvas-t1')       as HTMLCanvasElement;
  const t2CanvasEl    = document.getElementById('canvas-t2')       as HTMLCanvasElement;

  // Phase map page controls
  const mapResSelect     = document.getElementById('mapRes')                as HTMLSelectElement;
  const mapModeSelect    = document.getElementById('mapMode')               as HTMLSelectElement;
  const mapPaletteSelect = document.getElementById('mapPalette')            as HTMLSelectElement;
  const mapSpeedRange    = document.getElementById('mapSpeed')              as HTMLInputElement;
  const mapSpeedLabel    = document.getElementById('mapSpeedLabel')         as HTMLSpanElement;
  const mapPlayPauseBtn  = document.getElementById('mapPlayPauseBtn')       as HTMLButtonElement;
  const mapResetBtn      = document.getElementById('mapResetView')          as HTMLButtonElement;
  const mapCanvasEl      = document.getElementById('canvas-phasemap')       as HTMLCanvasElement;
  const probePendulumEl  = document.getElementById('canvas-probe-pendulum') as HTMLCanvasElement;
  const probePhaseEl     = document.getElementById('canvas-probe-phase')    as HTMLCanvasElement;
  const noGpuMsg         = document.getElementById('no-gpu-msg')            as HTMLElement;
  const probeMapHint     = document.getElementById('probe-map-hint')        as HTMLElement;

  // Physics panel refs
  const panels              = document.getElementById('panels')              as HTMLElement;
  const settingsFab         = document.getElementById('settingsFab')         as HTMLButtonElement;
  const physicsBackdrop     = document.getElementById('physics-backdrop')    as HTMLElement;
  const physL1Input         = document.getElementById('phys-L1')             as HTMLInputElement;
  const physL2Input         = document.getElementById('phys-L2')             as HTMLInputElement;
  const physM1Input         = document.getElementById('phys-m1')             as HTMLInputElement;
  const physM2Input         = document.getElementById('phys-m2')             as HTMLInputElement;
  const physDampingInput    = document.getElementById('phys-damping')        as HTMLInputElement;
  const physResetBtn        = document.getElementById('phys-reset-btn')      as HTMLButtonElement;
  const presetsSelect       = document.getElementById('presetsSelect')!      as HTMLSelectElement;

  // Export modal refs
  const mapExportBtn        = document.getElementById('mapExportBtn')          as HTMLButtonElement;
  const exportOverlay       = document.getElementById('export-overlay')        as HTMLElement;
  const exportSettings      = document.getElementById('export-settings')       as HTMLElement;
  const exportProgress      = document.getElementById('export-progress')       as HTMLElement;
  const exportFormatSelect  = document.getElementById('export-format')         as HTMLSelectElement;
  const exportResSelect     = document.getElementById('export-res')            as HTMLSelectElement;
  const exportDurInput      = document.getElementById('export-dur')            as HTMLInputElement;
  const exportLengthInput   = document.getElementById('export-length')         as HTMLInputElement;
  const exportFpsSelect     = document.getElementById('export-fps')            as HTMLSelectElement;
  const exportLoopSelect    = document.getElementById('export-loop')           as HTMLSelectElement;
  const exportQualitySelect = document.getElementById('export-quality')        as HTMLSelectElement;
  const exportColorsSelect  = document.getElementById('export-colors')         as HTMLSelectElement;
  const exportStepsHint     = document.getElementById('export-steps-hint')     as HTMLElement;
  const exportModeSelect    = document.getElementById('export-mode')           as HTMLSelectElement;
  const exportPaletteSelect = document.getElementById('export-palette')        as HTMLSelectElement;
  const exportRegionSel     = document.getElementById('export-region')         as HTMLSelectElement;
  const exportGenerateBtn   = document.getElementById('export-generate')       as HTMLButtonElement;
  const exportComposite     = document.getElementById('export-composite')      as HTMLCanvasElement;
  const exportProgBar       = document.getElementById('export-progress-bar')   as HTMLElement;
  const exportProgLabel     = document.getElementById('export-progress-label') as HTMLElement;
  const exportCloseBtn      = document.getElementById('export-close')          as HTMLButtonElement;
  const exportCancelBtn     = document.getElementById('export-cancel')         as HTMLButtonElement;

  // ── Pendulum view ─────────────────────────────────────────────────────────
  const pendulumView = new PendulumView(
    pendCanvasEl, phaseCanvasEl, t1CanvasEl, t2CanvasEl,
    showSelectContainer,
  );

  // ── Tile-hint dismissal ───────────────────────────────────────────────────
  let tileHintsDismissed = false;
  function dismissTileHints(): void {
    if (tileHintsDismissed) return;
    tileHintsDismissed = true;
    document.querySelectorAll<HTMLElement>('.tile-hint')
      .forEach(el => el.classList.add('hidden'));
  }

  pendulumView.onFirstDrag = dismissTileHints;

  // ── Angle inputs ──────────────────────────────────────────────────────────
  angleTheta1Input.addEventListener('change', () =>
    pendulumView.setBaseAngle1Deg(parseFloat(angleTheta1Input.value)));
  angleTheta2Input.addEventListener('change', () =>
    pendulumView.setBaseAngle2Deg(parseFloat(angleTheta2Input.value)));

  pendulumView.onAnglesChanged = (t1, t2) => {
    angleTheta1Input.value = String(Math.round(t1));
    angleTheta2Input.value = String(Math.round(t2));
    resetPresetLabel();
  };

  // ── Physics panel (always-visible floating panels on desktop; a collapsible
  //    bottom sheet, opened via #settingsFab, on mobile) ──────────────────────
  const mobileMQ = window.matchMedia('(max-width: 767px)');
  pendulumView.showPhysicsLabels = true;

  function setPhysicsPanelOpen(open: boolean): void {
    panels.classList.toggle('sheet-open', open);
    settingsFab.classList.toggle('active', open);
    if (mobileMQ.matches) pendulumView.showPhysicsLabels = open;
    physicsBackdrop.classList.toggle('active', open && mobileMQ.matches);
    if (open) {
      dismissTileHints();
      presetsSelect.classList.remove('phys-btn-glow');
      if (mobileMQ.matches) {
        const closeOnOutside = (ev: PointerEvent) => {
          if (!panels.contains(ev.target as Node) && ev.target !== settingsFab) {
            setPhysicsPanelOpen(false);
            document.removeEventListener('pointerdown', closeOnOutside, true);
          }
        };
        document.addEventListener('pointerdown', closeOnOutside, true);
      }
    }
  }

  mobileMQ.addEventListener('change', () => {
    if (mobileMQ.matches) {
      if (panels.classList.contains('sheet-open')) {
        physicsBackdrop.classList.toggle('active', true);
      }
    } else {
      setPhysicsPanelOpen(false);
      pendulumView.showPhysicsLabels = true;
    }
  });

  physicsBackdrop.addEventListener('click', () => setPhysicsPanelOpen(false));
  settingsFab.addEventListener('click', (e) => {
    e.stopPropagation();
    setPhysicsPanelOpen(!panels.classList.contains('sheet-open'));
  });

  function readPhysics() {
    return {
      g:       DEFAULT_PHYSICS.g,
      L1:      Math.max(0.1, parseFloat(physL1Input.value) || 1),
      L2:      Math.max(0.1, parseFloat(physL2Input.value) || 1),
      m1:      Math.max(0.1, parseFloat(physM1Input.value) || 1),
      m2:      Math.max(0.1, parseFloat(physM2Input.value) || 1),
      damping: Math.max(0,   parseFloat(physDampingInput.value) || 0),
    };
  }

  function applyPhysics(): void {
    const p = readPhysics();
    pendulumView.setPhysics(p);
    phaseMapView?.setPhysics(p);
  }

  for (const input of [physL1Input, physL2Input, physM1Input, physM2Input, physDampingInput]) {
    input.addEventListener('change', () => {
      applyPhysics();
      resetPresetLabel();
      const p = readPhysics();
      posthog.capture('physics parameters updated', {
        L1: p.L1, L2: p.L2, m1: p.m1, m2: p.m2, damping: p.damping,
      });
    });
  }

  physResetBtn.addEventListener('click', () => {
    physL1Input.value      = String(DEFAULT_PHYSICS.L1);
    physL2Input.value      = String(DEFAULT_PHYSICS.L2);
    physM1Input.value      = String(DEFAULT_PHYSICS.m1);
    physM2Input.value      = String(DEFAULT_PHYSICS.m2);
    physDampingInput.value = String(DEFAULT_PHYSICS.damping);
    applyPhysics();
    resetPresetLabel();
    posthog.capture('physics parameters reset');
  });

  // ── Presets ───────────────────────────────────────────────────────────────
  const presetsList = [
    { name: 'Butterfly Effect', theta1: 120, theta2: 90,  n: 20, spread: 1,   L1: 1,   m1: 1,   L2: 1,   m2: 1,   b: 0   },
    { name: 'Precipice',        theta1: 175, theta2: 175, n: 30, spread: 0.4, L1: 1,   m1: 1,   L2: 1,   m2: 1,   b: 0   },
    { name: 'Waltz',            theta1: 100, theta2: 80,  n: 6,  spread: 4,   L1: 1,   m1: 1,   L2: 1,   m2: 1,   b: 0.1 },
    { name: 'Asymmetry',        theta1: 90,  theta2: -60, n: 8,  spread: 5,   L1: 1.5, m1: 2,   L2: 0.6, m2: 0.4, b: 0   },
  ] as const;

  type Preset = typeof presetsList[number];

  let applyingPreset = false;

  function resetPresetLabel(): void {
    if (!applyingPreset) presetsSelect.value = '';
  }

  function applyPreset(p: Preset): void {
    applyingPreset = true;
    angleTheta1Input.value  = String(p.theta1);
    angleTheta2Input.value  = String(p.theta2);
    numPendulumsInput.value = String(p.n);
    deltaAngleInput.value   = String(p.spread);
    physL1Input.value       = String(p.L1);
    physM1Input.value       = String(p.m1);
    physL2Input.value       = String(p.L2);
    physM2Input.value       = String(p.m2);
    physDampingInput.value  = String(p.b);
    applyPhysics();
    pendulumView.setBaseAngle1Deg(p.theta1);
    pendulumView.setBaseAngle2Deg(p.theta2);
    pendulumView.setNumPendulums(p.n);
    pendulumView.setDeltaAngleDeg(p.spread);
    applyingPreset = false;
    posthog.capture('preset applied', { preset: p.name });
  }

  let presetsEverUsed = false;

  for (let i = 0; i < presetsList.length; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = presetsList[i].name;
    presetsSelect.appendChild(opt);
  }

  presetsSelect.addEventListener('change', () => {
    const idx = parseInt(presetsSelect.value, 10);
    if (isNaN(idx)) return;
    applyPreset(presetsList[idx]);
    dismissTileHints();
    if (!presetsEverUsed) {
      presetsEverUsed = true;
      presetsSelect.classList.remove('phys-btn-glow');
    }
  });

  // ── Pendulum controls ─────────────────────────────────────────────────────
  playPauseBtn.addEventListener('click', () => {
    pendulumView.paused = !pendulumView.paused;
    playPauseBtn.innerHTML = pendulumView.paused ? `${SVG_PLAY}Play` : `${SVG_PAUSE}Pause`;
    playPauseBtn.className = pendulumView.paused ? 'btn-play' : 'btn-pause';
    if (!pendulumView.paused && !presetsEverUsed) {
      presetsSelect.classList.add('phys-btn-glow');
    }
    posthog.capture(pendulumView.paused ? 'simulation paused' : 'simulation played');
  });

  resetBtn.addEventListener('click', () => {
    pendulumView.reset();
    posthog.capture('simulation reset');
  });

  numPendulumsInput.addEventListener('change', () => {
    const n = parseInt(numPendulumsInput.value, 10);
    if (n >= 1 && n <= 50) {
      pendulumView.setNumPendulums(n);
      resetPresetLabel();
      posthog.capture('pendulum count changed', { count: n });
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.num-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target!) as HTMLInputElement;
      if (parseInt(btn.dataset.dir!) > 0) input.stepUp(); else input.stepDown();
      // Round spread value to 1 decimal to avoid floating-point display noise
      if (input.id === 'deltaAngle') {
        input.value = String(Math.round(parseFloat(input.value) * 10) / 10);
      }
      input.dispatchEvent(new Event('change'));
    });
  });

  deltaAngleInput.addEventListener('change', () => {
    const d = parseFloat(deltaAngleInput.value);
    if (d > 0) {
      pendulumView.setDeltaAngleDeg(d);
      resetPresetLabel();
      posthog.capture('angle spread changed', { delta_angle_deg: d });
    }
  });

  speedRange.addEventListener('input', () => {
    pendulumView.stepsPerFrame = parseInt(speedRange.value, 10);
    speedLabel.textContent = speedRange.value;
    posthog.capture('simulation speed changed', { steps_per_frame: pendulumView.stepsPerFrame });
  });

  // ── Phase map view ────────────────────────────────────────────────────────
  const device = await getGPUDevice();
  let phaseMapView: PhaseMapView | null = null;

  if (device) {
    phaseMapView = new PhaseMapView(mapCanvasEl, device, probePendulumEl, probePhaseEl);
    await phaseMapView.initGPU();

    mapResSelect.addEventListener('change', () => {
      const resolution = parseInt(mapResSelect.value, 10);
      phaseMapView!.changeResolution(resolution);
      posthog.capture('phase map resolution changed', { resolution });
    });

    mapModeSelect.addEventListener('change', () => {
      const color_mode = mapModeSelect.value as ColorMode;
      phaseMapView!.setColorMode(color_mode);
      posthog.capture('phase map color mode changed', { color_mode });
    });

    mapPaletteSelect.addEventListener('change', () => {
      const palette = mapPaletteSelect.value as Palette;
      phaseMapView!.setPalette(palette);
      posthog.capture('phase map palette changed', { palette });
    });

    mapSpeedRange.addEventListener('input', () => {
      const steps_per_dispatch = parseInt(mapSpeedRange.value, 10);
      phaseMapView!.setStepsPerDispatch(steps_per_dispatch);
      mapSpeedLabel.textContent = mapSpeedRange.value;
      posthog.capture('phase map speed changed', { steps_per_dispatch });
    });

    mapPlayPauseBtn.addEventListener('click', () => {
      phaseMapView!.paused = !phaseMapView!.paused;
      mapPlayPauseBtn.innerHTML = phaseMapView!.paused ? `${SVG_PLAY}Play` : `${SVG_PAUSE}Pause`;
      mapPlayPauseBtn.className = phaseMapView!.paused ? 'btn-play' : 'btn-pause';
      posthog.capture(phaseMapView!.paused ? 'phase map paused' : 'phase map played');
    });

    mapCanvasEl.addEventListener('pointerdown', () => {
      probeMapHint.classList.add('hidden');
    }, { once: true });

    // ── Phase-map hover tooltip ───────────────────────────────────────────────
    const phaseHoverTip = document.createElement('div');
    phaseHoverTip.id = 'phase-hover-tip';
    document.body.appendChild(phaseHoverTip);

    mapCanvasEl.addEventListener('mousemove', (e) => {
      const rect = mapCanvasEl.getBoundingClientRect();
      const fracX = (e.clientX - rect.left)  / rect.width;
      const fracY = (e.clientY - rect.top)   / rect.height;
      const theta1 = Math.round(-180 + fracX * 360);
      const theta2 = Math.round( 180 - fracY * 360);
      phaseHoverTip.textContent = `θ₁ = ${theta1}°\nθ₂ = ${theta2}°`;
      phaseHoverTip.style.display = 'block';
      const gap = 14;
      const left = e.clientX + gap + phaseHoverTip.offsetWidth > window.innerWidth - 8
        ? e.clientX - phaseHoverTip.offsetWidth - gap
        : e.clientX + gap;
      phaseHoverTip.style.left = `${left}px`;
      phaseHoverTip.style.top  = `${e.clientY - 10}px`;
    });

    mapCanvasEl.addEventListener('mouseleave', () => {
      phaseHoverTip.style.display = 'none';
    });

    mapResetBtn.addEventListener('click', () => {
      phaseMapView!.reset();
      posthog.capture('phase map reset');
    });

    // ── Export modal ──────────────────────────────────────────────────────────
    type ExportFormat = 'png' | AnimationFormat;

    const EXPORT_SIZES: Record<ExportFormat, { sizes: number[]; initial: number }> = {
      png:  { sizes: [1000, 2000, 4000, 8000, 16000], initial: 4000 },
      mp4:  { sizes: [480, 720, 1080, 1440, 2160],    initial: 1080 },
      webm: { sizes: [480, 720, 1080, 1440, 2160],    initial: 1080 },
      gif:  { sizes: [240, 360, 480, 600, 800],       initial: 480 },
    };
    // GIF delays are whole 1/100 s and browsers slow down anything under 2/100 s, so GIF tops out at 50 fps.
    const VIDEO_FPS = [24, 30, 60];
    const GIF_FPS   = [15, 20, 25, 30, 50];

    const maxAnimationRes = maxAnimationResolution(device);
    if (typeof VideoEncoder === 'undefined') {
      for (const opt of exportFormatSelect.options) {
        if (opt.value === 'mp4' || opt.value === 'webm') {
          opt.disabled = true;
          opt.textContent += ' (unsupported)';
        }
      }
    }

    let activeExporter: { cancel(): void } | null = null;

    const exportFormat = (): ExportFormat => exportFormatSelect.value as ExportFormat;

    const readTiming = (): AnimationTiming => ({
      simSeconds:    Math.min(600, Math.max(1, parseFloat(exportDurInput.value) || 30)),
      lengthSeconds: Math.min(120, Math.max(1, parseFloat(exportLengthInput.value) || 10)),
      fps:           parseInt(exportFpsSelect.value, 10),
      pingPong:      exportLoopSelect.value === 'pingpong',
    });

    const QUALITY_LABELS: Record<VideoQuality, string> = { standard: 'Standard', high: 'High', 'very-high': 'Very high' };

    // Steps hint, plus the expected file size on each video quality option.
    const updateExportHints = (): void => {
      if (exportFormat() === 'png') {
        const dur = parseFloat(exportDurInput.value) || 30;
        const steps = Math.round(dur / DEFAULT_SIM.dt);
        exportStepsHint.textContent = `≈ ${steps.toLocaleString()} steps / tile`;
        return;
      }
      const timing = readTiming();
      const plan = planFrames(timing);
      exportStepsHint.textContent =
        `${plan.outputFrames.toLocaleString()} frames · ${plan.stepsPerFrame} step${plan.stepsPerFrame > 1 ? 's' : ''}/frame`;

      const resolution = parseInt(exportResSelect.value, 10);
      for (const opt of exportQualitySelect.options) {
        const quality = opt.value as VideoQuality;
        const bytes = (videoBitrate(resolution, timing.fps, quality) / 8) * (plan.outputFrames / timing.fps);
        opt.textContent = `${QUALITY_LABELS[quality]}  ·  ≈ ${formatBytes(bytes)}`;
      }
    };

    // Replaces a select's options, keeping the current choice when it is still offered.
    const fillOptions = (
      select: HTMLSelectElement,
      values: number[],
      initial: number,
      label: (n: number) => string,
      enabled: (n: number) => boolean = () => true,
    ): void => {
      const current = parseInt(select.value, 10);
      const chosen  = values.includes(current) && enabled(current) ? current : initial;
      select.replaceChildren(...values.map(n => {
        const opt = new Option(label(n), String(n), false, n === chosen);
        opt.disabled = !enabled(n);
        return opt;
      }));
    };

    // Resolutions, frame rates and visible rows all depend on the format.
    const syncExportFormat = (): void => {
      const format = exportFormat();
      const { sizes, initial } = EXPORT_SIZES[format];
      if (format === 'png') {
        fillOptions(exportResSelect, sizes, initial, n => {
          const tiles = Math.ceil(n / 1000) ** 2;
          return `${n} × ${n}  (${tiles} tile${tiles > 1 ? 's' : ''})`;
        });
      } else {
        fillOptions(exportResSelect, sizes, initial, n => `${n} × ${n}`, n => n <= maxAnimationRes);
        fillOptions(exportFpsSelect, format === 'gif' ? GIF_FPS : VIDEO_FPS, format === 'gif' ? 25 : 30, n => `${n} fps`);
      }
      exportSettings.querySelectorAll<HTMLElement>('[data-formats]').forEach(el => {
        el.hidden = !el.dataset.formats!.split(' ').includes(format);
      });
      updateExportHints();
    };

    const openExportModal = (): void => {
      exportModeSelect.value    = mapModeSelect.value;
      exportPaletteSelect.value = mapPaletteSelect.value;
      updateExportHints();
      exportSettings.style.display = '';
      exportProgress.style.display = 'none';
      exportCloseBtn.style.display = '';
      exportOverlay.classList.add('active');
    };

    const closeExportModal = (): void => {
      exportOverlay.classList.remove('active');
      activeExporter = null;
    };

    const confirmCancel = (): void => {
      if (confirm('Stop rendering? Partially computed data will be discarded.')) {
        activeExporter?.cancel();
      }
    };

    syncExportFormat();
    exportFormatSelect.addEventListener('change', syncExportFormat);
    mapExportBtn.addEventListener('click', openExportModal);
    exportCloseBtn.addEventListener('click', closeExportModal);
    exportResSelect.addEventListener('change', updateExportHints);
    exportDurInput.addEventListener('input', updateExportHints);
    exportLengthInput.addEventListener('input', updateExportHints);
    exportFpsSelect.addEventListener('change', updateExportHints);
    exportLoopSelect.addEventListener('change', updateExportHints);

    exportOverlay.addEventListener('click', (e) => {
      if (e.target !== exportOverlay) return;
      if (activeExporter) confirmCancel();
      else closeExportModal();
    });

    exportCancelBtn.addEventListener('click', () => {
      if (activeExporter) confirmCancel();
    });

    exportGenerateBtn.addEventListener('click', async () => {
      const format          = exportFormat();
      const resolution      = parseInt(exportResSelect.value, 10);
      const durationSeconds = parseFloat(exportDurInput.value) || 30;
      const colorMode       = exportModeSelect.value as ColorMode;
      const palette         = exportPaletteSelect.value as Palette;
      const region          = exportRegionSel.value === 'current'
        ? phaseMapView!.getRegion()
        : { theta1Min: -Math.PI, theta1Max: Math.PI, theta2Min: -Math.PI, theta2Max: Math.PI };
      const physics         = phaseMapView!.getPhysics();
      const timing          = readTiming();
      const animationProps  = format === 'png'
        ? {}
        : { fps: timing.fps, length_seconds: timing.lengthSeconds, ping_pong: timing.pingPong };
      posthog.capture('phase map export started', { format, resolution, duration_seconds: durationSeconds, color_mode: colorMode, palette, region_type: exportRegionSel.value, ...animationProps });

      // PNG tiles are composited into this canvas at full size; animations only mirror frames into it.
      const previewSize = format === 'png' ? resolution : Math.min(resolution, 540);
      exportComposite.width  = previewSize;
      exportComposite.height = previewSize;
      const ctx = exportComposite.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, previewSize, previewSize);

      exportSettings.style.display = 'none';
      exportProgress.style.display = '';
      exportCloseBtn.style.display = 'none';
      exportProgBar.style.width = '0%';
      exportProgLabel.textContent = 'Starting…';

      const wasPaused = phaseMapView!.paused;
      phaseMapView!.paused = true;

      const onProgress = (fraction: number, label: string): void => {
        exportProgBar.style.width = `${Math.round(fraction * 100)}%`;
        exportProgLabel.textContent = label;
      };

      let done   = false;
      let failed = false;
      try {
        if (format === 'png') {
          const exporter = new PhaseMapExporter();
          activeExporter = exporter;
          done = await exporter.run(device, {
            resolution,
            durationSeconds,
            colorMode,
            palette,
            region,
            physics,
            maxFlipTime: 50,
            compositeCanvas: exportComposite,
            onProgress,
          }) === 'done';
        } else {
          const exporter = new PhaseMapAnimationExporter();
          activeExporter = exporter;
          const result = await exporter.run(device, {
            format,
            resolution,
            ...timing,
            quality:   exportQualitySelect.value as VideoQuality,
            gifColors: parseInt(exportColorsSelect.value, 10),
            colorMode,
            palette,
            region,
            physics,
            maxFlipTime: 50,
            previewCanvas: exportComposite,
            onProgress,
          });
          if (result.status === 'done') {
            done = true;
            showToast(`Saved ${result.filename} · ${formatBytes(result.bytes)}`, 5000);
          }
        }
      } catch (err) {
        failed = true;
        console.error(err);
        showToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 6000);
        posthog.capture('phase map export failed', { format, resolution, error: String(err) });
      } finally {
        activeExporter = null;
        phaseMapView!.paused = wasPaused;
      }

      if (done) {
        posthog.capture('phase map export completed', { format, resolution, duration_seconds: durationSeconds, color_mode: colorMode, palette, ...animationProps });
        closeExportModal();
      } else {
        if (!failed) posthog.capture('phase map export cancelled', { format, resolution, duration_seconds: durationSeconds });
        exportSettings.style.display = '';
        exportProgress.style.display = 'none';
        exportCloseBtn.style.display = '';
      }
    });

  } else {
    tabPhasemap.classList.add('tab-unavailable');
    tabPhasemap.title = 'WebGPU not available in this browser';
    mapPlayPauseBtn.disabled = true;
    noGpuMsg.style.display = 'block';
    mapCanvasEl.style.display = 'none';

    tabPhasemap.addEventListener('click', (e) => {
      e.stopPropagation();
      showToast('Phase Map requires a desktop browser with WebGPU');
    });
  }

  // ── Tab navigation ────────────────────────────────────────────────────────
  const panelSectionPendulum  = document.getElementById('panel-section-pendulum')  as HTMLElement;
  const panelSectionPhasemap  = document.getElementById('panel-section-phasemap')  as HTMLElement;

  // Default landing page is Phase Map (matches the initial HTML/CSS active state,
  // so there is no visible tab flash on load). Falls back to Pendulum below when
  // WebGPU is unavailable.
  let currentPage: 'pendulum' | 'phasemap' | 'tech' = phaseMapView ? 'phasemap' : 'pendulum';
  if (phaseMapView) phaseMapView.activate();
  else pendulumView.activate();

  function switchTo(page: 'pendulum' | 'phasemap' | 'tech'): void {
    if (page === currentPage) return;
    currentPage = page;

    pagePendulum.style.display = 'none';
    pagePhasemap.style.display = 'none';
    pageTech.style.display     = 'none';
    tabPendulum.classList.remove('active');
    tabPhasemap.classList.remove('active');
    tabTech.classList.remove('active');

    panelSectionPendulum.hidden = page !== 'pendulum';
    panelSectionPhasemap.hidden = page !== 'phasemap';

    if (page === 'pendulum') {
      app.style.display = 'flex';
      settingsFab.style.display = '';
      pagePendulum.style.display = 'flex';
      tabPendulum.classList.add('active');
      phaseMapView?.deactivate();
      pendulumView.activate();
    } else if (page === 'phasemap') {
      app.style.display = 'flex';
      settingsFab.style.display = '';
      pagePhasemap.style.display = 'flex';
      tabPhasemap.classList.add('active');
      tabPhasemap.classList.remove('tab-flash');
      pendulumView.deactivate();
      phaseMapView?.activate();
    } else {
      setPhysicsPanelOpen(false);
      app.style.display = 'none';
      settingsFab.style.display = 'none';
      pageTech.style.display = 'flex';
      tabTech.classList.add('active');
      pendulumView.deactivate();
      phaseMapView?.deactivate();
    }
  }

  tabPendulum.addEventListener('click', () => { switchTo('pendulum'); posthog.capture('tab switched', { tab: 'pendulum' }); });
  tabPhasemap.addEventListener('click', () => { if (phaseMapView) { switchTo('phasemap'); posthog.capture('tab switched', { tab: 'phasemap' }); } });
  tabTech.addEventListener('click', () => { switchTo('tech'); posthog.capture('tab switched', { tab: 'tech' }); });

  // ── Without WebGPU, correct the Phase Map default back to Pendulum ──────────
  if (!phaseMapView) {
    // Force the DOM (which defaults to Phase Map) onto the Pendulum page.
    currentPage = 'phasemap';
    switchTo('pendulum');
  }

  // ── Help-icon tooltips (fixed position, avoids sidebar overflow clipping) ───
  const helpTooltip = document.createElement('div');
  helpTooltip.id = 'phys-tooltip';
  document.body.appendChild(helpTooltip);

  document.querySelectorAll<HTMLElement>('.help-icon').forEach(icon => {
    icon.addEventListener('mouseenter', () => {
      const tip = icon.dataset.tip;
      if (!tip) return;
      helpTooltip.textContent = tip;
      helpTooltip.style.opacity = '0';
      helpTooltip.style.display = 'block';

      const rect = icon.getBoundingClientRect();
      const left = Math.max(8, rect.right - 200);
      const top = rect.top - helpTooltip.offsetHeight - 8;
      helpTooltip.style.left = `${left}px`;
      helpTooltip.style.top = `${top}px`;
      helpTooltip.style.opacity = '1';
    });

    icon.addEventListener('mouseleave', () => {
      helpTooltip.style.opacity = '0';
    });
  });
}

// Initialize Vercel Web Analytics
inject({ mode: 'production' });

init();
