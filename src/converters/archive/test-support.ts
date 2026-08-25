/** Tiny fixtures shared by this directory's `*.test.ts` files. Not a converter. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConversionInput, ConversionOutput, ConvertContext } from '@core/types';

export function makeScratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'warp-archive-test-'));
}

export function makeCtx(scratchDir: string, signal?: AbortSignal): ConvertContext {
  return {
    onProgress: () => {},
    signal: signal ?? new AbortController().signal,
    scratchDir,
    log: () => {},
  };
}

export function makeInput(filePath: string, format: string): ConversionInput {
  return {
    path: filePath,
    format,
    size: fs.statSync(filePath).size,
    readBuffer: () => fs.promises.readFile(filePath),
    createReadStream: () => fs.createReadStream(filePath),
  };
}

export function makeOutput(filePath: string, format: string): ConversionOutput {
  return { path: filePath, format };
}
