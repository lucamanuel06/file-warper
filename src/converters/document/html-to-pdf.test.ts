import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { htmlToPdfConverter } from './html-to-pdf';
import type { PdfRenderer, PrintToPdfOptions } from './pdf-render';
import { resetPdfRenderer, setPdfRenderer } from './pdf-render';

const FAKE_PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

function makeInput(path: string): ConversionInput {
  const buf = Buffer.from('<html><body>hi</body></html>', 'utf8');
  return {
    path,
    format: 'html',
    size: buf.byteLength,
    async readBuffer() {
      return buf;
    },
    createReadStream() {
      throw new Error('not used in these tests');
    },
  };
}

function makeContext(scratchDir: string): ConvertContext {
  return {
    onProgress() {},
    signal: new AbortController().signal,
    scratchDir,
    log() {},
  };
}

describe('html-to-pdf converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-html-pdf-'));
  });

  afterEach(async () => {
    resetPdfRenderer();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports unavailable when no renderer has been registered', async () => {
    const availability = await htmlToPdfConverter.availability();
    expect(availability.available).toBe(false);
  });

  it('reports available once a renderer is registered', async () => {
    setPdfRenderer({
      async printToPdf() {
        return FAKE_PDF_BYTES;
      },
    });
    const availability = await htmlToPdfConverter.availability();
    expect(availability).toEqual({ available: true });
  });

  it('writes the renderer bytes to the output path unchanged', async () => {
    let seenOptions: PrintToPdfOptions | undefined;
    const fake: PdfRenderer = {
      async printToPdf(htmlPath, opts) {
        seenOptions = opts;
        expect(htmlPath).toBe(join(dir, 'in.html'));
        return FAKE_PDF_BYTES;
      },
    };
    setPdfRenderer(fake);

    const input = makeInput(join(dir, 'in.html'));
    const outputPath = join(dir, 'out.pdf');
    const ctx = makeContext(dir);

    const result = await htmlToPdfConverter.convert(
      input,
      { path: outputPath, format: 'pdf' },
      { pageSize: 'A4' },
      ctx,
    );

    const written = await readFile(outputPath);
    expect(written.equals(FAKE_PDF_BYTES)).toBe(true);
    expect(result.bytes).toBe(FAKE_PDF_BYTES.byteLength);
    expect(seenOptions?.pageSize).toEqual({ format: 'A4' });
  });

  it('maps the "letter" option to the Letter page format', async () => {
    let seenOptions: PrintToPdfOptions | undefined;
    setPdfRenderer({
      async printToPdf(_path, opts) {
        seenOptions = opts;
        return FAKE_PDF_BYTES;
      },
    });

    await htmlToPdfConverter.convert(
      makeInput(join(dir, 'in.html')),
      { path: join(dir, 'out.pdf'), format: 'pdf' },
      { pageSize: 'letter' },
      makeContext(dir),
    );

    expect(seenOptions?.pageSize).toEqual({ format: 'Letter' });
  });

  it('omits pageSize entirely for the default "auto" option', async () => {
    let seenOptions: PrintToPdfOptions | undefined;
    setPdfRenderer({
      async printToPdf(_path, opts) {
        seenOptions = opts;
        return FAKE_PDF_BYTES;
      },
    });

    await htmlToPdfConverter.convert(
      makeInput(join(dir, 'in.html')),
      { path: join(dir, 'out.pdf'), format: 'pdf' },
      {},
      makeContext(dir),
    );

    expect(seenOptions?.pageSize).toBeUndefined();
  });

  it('throws a ConversionError when the conversion is already cancelled', async () => {
    setPdfRenderer({
      async printToPdf() {
        return FAKE_PDF_BYTES;
      },
    });
    const controller = new AbortController();
    controller.abort();
    const ctx: ConvertContext = {
      onProgress() {},
      signal: controller.signal,
      scratchDir: dir,
      log() {},
    };

    await expect(
      htmlToPdfConverter.convert(
        makeInput(join(dir, 'in.html')),
        { path: join(dir, 'out.pdf'), format: 'pdf' },
        {},
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' });
  });

  it('exposes the pageSize options schema', () => {
    expect(htmlToPdfConverter.optionsSchema?.fields).toEqual([
      {
        key: 'pageSize',
        kind: 'select',
        label: 'Page size',
        choices: [
          { value: 'auto', label: 'Auto' },
          { value: 'A4', label: 'A4' },
          { value: 'letter', label: 'Letter' },
        ],
        default: 'auto',
      },
    ]);
  });
});
