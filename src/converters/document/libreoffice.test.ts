import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { libreOfficeConverter, resetLibreOfficeProbeCache } from './libreoffice';

function makeInput(path: string, format: string): ConversionInput {
  const buf = Buffer.from('stub');
  return {
    path,
    format,
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

describe('libreoffice converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-libreoffice-'));
    resetLibreOfficeProbeCache();
  });

  afterEach(async () => {
    resetLibreOfficeProbeCache();
    await rm(dir, { recursive: true, force: true });
  });

  it('never throws from availability(), regardless of whether soffice is installed', async () => {
    const availability = await libreOfficeConverter.availability();
    expect(typeof availability.available).toBe('boolean');
    if (!availability.available) {
      expect(availability.reason).toBe('LibreOffice not installed');
      expect(availability.remedy).toContain('Install LibreOffice');
    }
  });

  it('declares inputs/outputs regardless of availability (the router excludes edges, not this file)', () => {
    expect(libreOfficeConverter.inputs).toContain('docx');
    expect(libreOfficeConverter.outputs).toContain('odt');
    expect(libreOfficeConverter.outputs).toContain('docx');
  });

  it('supports() only allows the declared Office edges', () => {
    expect(libreOfficeConverter.supports?.('docx', 'odt')).toBe(true);
    expect(libreOfficeConverter.supports?.('odt', 'docx')).toBe(true);
    expect(libreOfficeConverter.supports?.('doc', 'docx')).toBe(true);
    expect(libreOfficeConverter.supports?.('rtf', 'docx')).toBe(true);
    expect(libreOfficeConverter.supports?.('pptx', 'odp')).toBe(true);
    expect(libreOfficeConverter.supports?.('odp', 'pptx')).toBe(true);
    // Never a write target for doc/ppt (readOnly formats in the registry).
    expect(libreOfficeConverter.supports?.('docx', 'doc')).toBe(false);
    // Never an edge this adapter doesn't declare.
    expect(libreOfficeConverter.supports?.('docx', 'pdf')).toBe(false);
  });

  it('reports a high-fidelity, high-effort cost', () => {
    const cost = libreOfficeConverter.cost('docx', 'odt');
    expect(cost.retention).toBeGreaterThan(0.9);
    expect(cost.effort).toBeGreaterThan(5);
  });

  it('rejects an unsupported pair with E_UNSUPPORTED_FEATURE before ever touching soffice', async () => {
    await expect(
      libreOfficeConverter.convert(
        makeInput(join(dir, 'in.docx'), 'docx'),
        { path: join(dir, 'out.pdf'), format: 'pdf' },
        {},
        makeContext(dir),
      ),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED_FEATURE' });
  });

  it('throws a ConversionError when the conversion is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx: ConvertContext = {
      onProgress() {},
      signal: controller.signal,
      scratchDir: dir,
      log() {},
    };
    await expect(
      libreOfficeConverter.convert(
        makeInput(join(dir, 'in.docx'), 'docx'),
        { path: join(dir, 'out.odt'), format: 'odt' },
        {},
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' });
  });

  it('surfaces E_UNAVAILABLE from convert() when soffice cannot be found', async () => {
    // This dev/test environment has no LibreOffice installed, so this
    // exercises the real, unmocked probe path.
    const availability = await libreOfficeConverter.availability();
    if (availability.available) {
      // If some environment running this suite does have LibreOffice, this
      // particular negative-path assertion doesn't apply — skip quietly.
      return;
    }
    await expect(
      libreOfficeConverter.convert(
        makeInput(join(dir, 'in.docx'), 'docx'),
        { path: join(dir, 'out.odt'), format: 'odt' },
        {},
        makeContext(dir),
      ),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
  });
});
