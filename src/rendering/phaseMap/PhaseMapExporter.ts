import { PhaseMapBackend } from './PhaseMapBackend';
import { PhaseMapRenderer } from './PhaseMapRenderer';
import { DEFAULT_SIM } from '../../core/config';
import type { ColorMode, Palette, PhaseRegion, PhysicsParams } from '../../core/types';

const TILE_SIZE        = 1000;
const STEPS_PER_BATCH  = 20;
const PREVIEW_INTERVAL = 5;

export interface ExportOptions {
  resolution: number;
  durationSeconds: number;
  colorMode: ColorMode;
  palette: Palette;
  region: PhaseRegion;
  physics: PhysicsParams;
  maxFlipTime: number;
  compositeCanvas: HTMLCanvasElement;
  onProgress: (fraction: number, label: string) => void;
}

export class PhaseMapExporter {
  private cancelled = false;

  cancel(): void { this.cancelled = true; }

  async run(device: GPUDevice, opts: ExportOptions): Promise<'done' | 'cancelled'> {
    const { resolution, durationSeconds, colorMode, palette, region, physics, maxFlipTime, compositeCanvas } = opts;
    const compositeCtx    = compositeCanvas.getContext('2d')!;
    const freeze          = colorMode === 'flipTime';
    const totalDispatches = Math.ceil(durationSeconds / DEFAULT_SIM.dt / STEPS_PER_BATCH);

    const numTilesX  = Math.ceil(resolution / TILE_SIZE);
    const numTilesY  = Math.ceil(resolution / TILE_SIZE);
    const totalTiles = numTilesX * numTilesY;

    let tileIdx = 0;

    for (let ty = 0; ty < numTilesY && !this.cancelled; ty++) {
      for (let tx = 0; tx < numTilesX && !this.cancelled; tx++) {
        const x0 = tx * TILE_SIZE;
        const y0 = ty * TILE_SIZE;
        const tW = Math.min(TILE_SIZE, resolution - x0);
        const tH = Math.min(TILE_SIZE, resolution - y0);

        const tileCanvas = document.createElement('canvas');
        tileCanvas.width  = tW;
        tileCanvas.height = tH;

        const tileRegion = this.subRegion(region, resolution, resolution, x0, y0, tW, tH);
        const backend  = new PhaseMapBackend();
        const renderer = new PhaseMapRenderer();
        try {
          await backend.init(device, tW, tH, tileRegion);
          await renderer.init(device, tileCanvas);
          renderer.setStateBuffer(backend.getStateBuffer());
          renderer.setView(tileRegion);

          for (let d = 0; d < totalDispatches && !this.cancelled; d++) {
            backend.step(physics, DEFAULT_SIM.dt, STEPS_PER_BATCH, freeze);

            if (d % PREVIEW_INTERVAL === 0) {
              renderer.render({ colorMode, palette, maxFlipTime });
              compositeCtx.drawImage(tileCanvas, x0, y0, tW, tH);
              const overall = (tileIdx * totalDispatches + d) / (totalTiles * totalDispatches);
              opts.onProgress(
                overall,
                `Tile ${tileIdx + 1} / ${totalTiles}  ·  ${Math.round((d / totalDispatches) * 100)}%`,
              );
              await new Promise<void>(r => setTimeout(r, 0));
            }
          }

          if (!this.cancelled) {
            renderer.render({ colorMode, palette, maxFlipTime });
            compositeCtx.drawImage(tileCanvas, x0, y0, tW, tH);
          }
        } finally {
          backend.destroy();
          renderer.destroy();
        }

        tileIdx++;
      }
    }

    if (this.cancelled) return 'cancelled';

    opts.onProgress(1, 'Encoding PNG…');
    await new Promise<void>(r => setTimeout(r, 0));

    const blob = await new Promise<Blob>(resolve =>
      compositeCanvas.toBlob(b => resolve(b!), 'image/png'),
    );
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url,
      download: `phasemap_${resolution}px_${durationSeconds}s.png`,
    }).click();
    URL.revokeObjectURL(url);

    return 'done';
  }

  private subRegion(
    region: PhaseRegion,
    totalW: number,
    totalH: number,
    x0: number,
    y0: number,
    tW: number,
    tH: number,
  ): PhaseRegion {
    const fx0    = x0 / totalW;
    const fx1    = (x0 + tW) / totalW;
    const fy0    = y0 / totalH;
    const fy1    = (y0 + tH) / totalH;
    const t1Span = region.theta1Max - region.theta1Min;
    const t2Span = region.theta2Max - region.theta2Min;
    return {
      theta1Min: region.theta1Min + fx0 * t1Span,
      theta1Max: region.theta1Min + fx1 * t1Span,
      theta2Max: region.theta2Max - fy0 * t2Span,
      theta2Min: region.theta2Max - fy1 * t2Span,
    };
  }
}
