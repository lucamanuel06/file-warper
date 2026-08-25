/**
 * Test-only helpers shared across this directory's *.test.ts files. Not a
 * *.test.ts file itself, so vitest never collects it directly.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';

export async function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fw-data-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function makeInput(text: string, format: string, dir: string): ConversionInput {
  const buf = Buffer.from(text, 'utf8');
  return {
    path: path.join(dir, `input.${format}`),
    format,
    size: buf.length,
    async readBuffer() {
      return buf;
    },
    createReadStream(): NodeJS.ReadableStream {
      throw new Error('createReadStream is not used by data converters');
    },
  };
}

export function makeCtx(): ConvertContext {
  return {
    onProgress() {},
    signal: new AbortController().signal,
    scratchDir: '',
    log() {},
  };
}

export async function readOutput(outputPath: string): Promise<string> {
  return readFile(outputPath, 'utf8');
}
