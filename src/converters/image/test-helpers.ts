import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConversionInput, ConvertContext, FormatId } from '@core/types';

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function fakeInput(
  filePath: string,
  format: FormatId,
): Promise<ConversionInput> {
  const st = await stat(filePath);
  return {
    path: filePath,
    format,
    size: st.size,
    readBuffer: () => readFile(filePath),
    createReadStream: () => createReadStream(filePath),
  };
}

export function fakeContext(scratchDir: string, signal?: AbortSignal): ConvertContext {
  return {
    onProgress() {},
    signal: signal ?? new AbortController().signal,
    scratchDir,
    log() {},
  };
}
