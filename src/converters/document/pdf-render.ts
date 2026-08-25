/**
 * Integration point for W2's `src/runtime/main-runner.ts` (an offscreen
 * BrowserWindow pool). `html -> pdf` must run with `residency: 'main'`
 * because `webContents.printToPDF` only exists in the Electron main process
 * — a converter in this directory never imports `electron` directly.
 *
 * W2's runtime host calls `setPdfRenderer()` once at startup with a real
 * implementation. Until that happens, `getPdfRenderer()` throws a
 * `ConversionError` with a plain-English `userMessage` instead of the
 * converter crashing on `undefined`.
 */

import { ConversionError } from '@core/types';

export interface PdfPageSize {
  /** Points. Overridden by `format` when both are given. */
  readonly width?: number;
  readonly height?: number;
  /** Matches the "Page size" document option in spec-ui.md §2. */
  readonly format?: 'A4' | 'Letter';
}

export interface PdfMargins {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface PrintToPdfOptions {
  readonly pageSize?: PdfPageSize;
  readonly landscape?: boolean;
  readonly margins?: PdfMargins;
  /** Default true — documents render with their CSS backgrounds. */
  readonly printBackground?: boolean;
  readonly signal: AbortSignal;
}

export interface PdfRenderer {
  /**
   * Render a self-contained HTML file to a PDF buffer.
   *
   * Caller contract (this module's responsibility): `htmlPath` points at a
   * file whose assets are already inlined as `data:` URIs or resolvable
   * through the app's custom protocol — never a bare `file://` reference
   * that could reach the network.
   *
   * Implementation contract (W2's responsibility): navigate a hidden,
   * sandboxed `BrowserWindow` to the file, then IN-PAGE `await
   * document.fonts.ready` and `await Promise.all([...images].map(img =>
   * img.decode()))` before calling `webContents.printToPDF` — skipping
   * this produces blank or unstyled pages nondeterministically
   * (spec-engines.md §3.4). Honour `options.signal`: destroy the window if
   * the caller aborts mid-render.
   */
  printToPdf(htmlPath: string, options: PrintToPdfOptions): Promise<Buffer>;
}

let renderer: PdfRenderer | undefined;

/** Called once by W2's runtime host at startup. */
export function setPdfRenderer(impl: PdfRenderer): void {
  renderer = impl;
}

/** Test-only: reset between unit tests that stub the renderer. */
export function resetPdfRenderer(): void {
  renderer = undefined;
}

export function getPdfRenderer(): PdfRenderer {
  if (!renderer) {
    throw new ConversionError({
      code: 'E_UNAVAILABLE',
      userMessage: 'PDF rendering is not ready yet. Please try again in a moment.',
      detail: 'setPdfRenderer() was never called by the runtime host.',
      retryable: true,
    });
  }
  return renderer;
}
