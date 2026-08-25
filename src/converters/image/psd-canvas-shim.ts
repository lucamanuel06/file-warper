import { initializeCanvas } from 'ag-psd';

/**
 * ag-psd calls into a DOM-shaped Canvas API to materialize composite/layer
 * pixel buffers, even when reading with `useImageData: true`. There is no
 * `canvas` npm package in this project's dependency set, so this supplies
 * the minimal shape ag-psd actually touches, entirely in pure JS.
 */
function createImageData(width: number, height: number) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function createCanvas(width: number, height: number) {
  const context = {
    createImageData,
    putImageData() {},
    getImageData(_x: number, _y: number, w: number, h: number) {
      return createImageData(w, h);
    },
    drawImage() {},
  };
  return { width, height, getContext: () => context };
}

let initialized = false;

export function ensureCanvasShim(): void {
  if (initialized) return;
  initialized = true;
  initializeCanvas(
    createCanvas as unknown as Parameters<typeof initializeCanvas>[0],
    createImageData as unknown as Parameters<typeof initializeCanvas>[1],
  );
}
