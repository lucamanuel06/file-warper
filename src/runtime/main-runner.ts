/**
 * The `residency: 'main'` executor. `BrowserWindow.printToPDF` (and pdf.js
 * canvas rasterisation) cannot run inside a utilityProcess — no `BrowserWindow`
 * there — so a small pool of offscreen windows lives in main instead.
 *
 * Converters never import Electron; a converter that needs this sets
 * `residency: 'main'` and receives this API through `ctx` (wired by whichever
 * executor dispatches `residency: 'main'` hops — see scheduler.ts).
 */

import type { ConvertContext } from '@core/types';
import { BrowserWindow } from 'electron';

const POOL_SIZE = 2;

/** Runs inside the offscreen page before printing — blank pages otherwise. */
const WAIT_FOR_PAINT_READY = `
(async () => {
  await document.fonts.ready;
  await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})));
  return true;
})();
`;

export interface PrintToPdfOptions {
  /** Ignored when the document's own \`@page\` CSS declares a size/orientation. */
  readonly landscape?: boolean;
  readonly pageWidthIn?: number;
  readonly pageHeightIn?: number;
  readonly marginsIn?: number;
  readonly printBackground?: boolean;
}

interface Slot {
  readonly win: BrowserWindow;
  busy: boolean;
}

/**
 * `ConvertContext` (frozen, in `@core/types`) has no room for this — a
 * `residency: 'main'` converter's `convert()` should type its `ctx` parameter
 * as `MainConvertContext` instead. TypeScript's bivariant method-parameter
 * check allows a `Converter.convert` implementation to declare a more
 * specific `ctx` type than the interface requires, so this is a drop-in for
 * W5's document converters — no change to the frozen contract needed.
 */
export interface MainConvertContext extends ConvertContext {
  readonly main: Pick<MainHopRunner, 'printHtmlToPdf' | 'rasterizePdfPage'>;
}

export class MainHopRunner {
  private slots: Slot[] = [];
  private readonly waiters: Array<(slot: Slot) => void> = [];

  start(): void {
    for (let i = 0; i < POOL_SIZE; i++) {
      const win = new BrowserWindow({
        show: false,
        width: 1024,
        height: 1400,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          offscreen: true,
        },
      });
      this.slots.push({ win, busy: false });
    }
  }

  private acquire(): Promise<Slot> {
    const free = this.slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(slot: Slot): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(slot);
      return;
    }
    slot.busy = false;
  }

  /**
   * Prints already-rendered HTML (from our own docx/md->html hop, or a
   * document the app trusts) to a PDF buffer. `did-finish-load` alone is not
   * enough — fonts and images can still be decoding — hence the in-page wait.
   */
  async printHtmlToPdf(html: string, opts: PrintToPdfOptions = {}): Promise<Buffer> {
    const slot = await this.acquire();
    try {
      const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
      await slot.win.loadURL(dataUrl);
      await slot.win.webContents.executeJavaScript(WAIT_FOR_PAINT_READY);

      const pageSize =
        opts.pageWidthIn !== undefined && opts.pageHeightIn !== undefined
          ? { width: opts.pageWidthIn, height: opts.pageHeightIn }
          : ('A4' as const);
      const margin = opts.marginsIn;

      return await slot.win.webContents.printToPDF({
        landscape: opts.landscape ?? false,
        printBackground: opts.printBackground ?? true,
        pageSize,
        // `@page` CSS wins over `landscape`/`pageSize` unless we opt out here;
        // we deliberately leave it on so an author's stylesheet is honoured.
        preferCSSPageSize: true,
        margins:
          margin !== undefined
            ? { top: margin, bottom: margin, left: margin, right: margin }
            : undefined,
      });
    } finally {
      this.release(slot);
    }
  }

  /**
   * Rasterises one page of a PDF to a PNG buffer via pdf.js running inside an
   * offscreen page, for pdf->image conversions. `harnessUrl` must point at a
   * bundled page (served over `app://`) that loads pdf.js and exposes a
   * `window.__rasterize(pdfBase64, pageNumber, scale) -> Promise<string>`
   * (data URL) function — the actual harness page and pdf.js wiring is a
   * converter-side (W5) concern; this just hosts it.
   */
  async rasterizePdfPage(
    harnessUrl: string,
    pdfBytes: Buffer,
    pageNumber: number,
    scale = 2,
  ): Promise<Buffer> {
    const slot = await this.acquire();
    try {
      await slot.win.loadURL(harnessUrl);
      const dataUrl = (await slot.win.webContents.executeJavaScript(
        `window.__rasterize(${JSON.stringify(pdfBytes.toString('base64'))}, ${pageNumber}, ${scale})`,
      )) as string;
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      return Buffer.from(base64, 'base64');
    } finally {
      this.release(slot);
    }
  }

  shutdown(): void {
    for (const slot of this.slots) {
      if (!slot.win.isDestroyed()) slot.win.destroy();
    }
    this.slots = [];
  }
}
