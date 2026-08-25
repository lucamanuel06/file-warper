/**
 * Shared "explode a container into a real directory tree, then rebuild a
 * (possibly different) container from that tree" pipeline used by every
 * archive<->archive converter in this directory.
 *
 * Staging through real files (rather than buffering whole archives in
 * memory) is deliberate: `tar` and `7za` both need real file paths, and it
 * keeps memory bounded regardless of archive size.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ConvertContext } from '@core/types';
import { ConversionError } from '@core/types';
import type { ArchiverError } from 'archiver';
import { ZipArchive } from 'archiver';
import type { ReadEntry } from 'tar';
import * as tar from 'tar';
import * as yauzl from 'yauzl';
import { assertAllSafe, assertSafeEntryPath } from './safe-path';
import { sevenAdd, sevenExtractFull, sevenList } from './seven-zip';

export type RepackFormat = 'zip' | 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.xz' | '7z';

function cancelledError(): ConversionError {
  return new ConversionError({
    code: 'E_CANCELLED',
    userMessage: 'The conversion was cancelled.',
    retryable: false,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledError();
}

function engineError(err: unknown, userMessage: string): ConversionError {
  return new ConversionError({
    code: 'E_ENGINE',
    userMessage,
    detail: err instanceof Error ? err.message : String(err),
    retryable: false,
    cause: err,
  });
}

async function mkdtemp(scratchDir: string, prefix: string): Promise<string> {
  await fs.promises.mkdir(scratchDir, { recursive: true });
  return fs.promises.mkdtemp(path.join(scratchDir, prefix));
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

async function extractZip(
  archivePath: string,
  destDir: string,
  ctx: ConvertContext,
): Promise<void> {
  const zipfile = await yauzl.openPromise(archivePath, { lazyEntries: true });
  try {
    for await (const entry of zipfile.eachEntry()) {
      throwIfAborted(ctx.signal);
      const isDir = entry.fileName.endsWith('/');
      const target = assertSafeEntryPath(destDir, entry.fileName);
      if (isDir) {
        await fs.promises.mkdir(target, { recursive: true });
        continue;
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const readStream = await zipfile.openReadStreamPromise(entry);
      await pipeline(readStream, fs.createWriteStream(target));
    }
  } catch (err) {
    if (err instanceof ConversionError) throw err;
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: 'This ZIP archive could not be read; it may be corrupt.',
      detail: err instanceof Error ? err.message : String(err),
      retryable: false,
      cause: err,
    });
  } finally {
    try {
      zipfile.close();
    } catch {
      // already closed
    }
  }
}

async function createZip(
  srcDir: string,
  archivePath: string,
  ctx: ConvertContext,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const output = fs.createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      archive.abort();
      reject(cancelledError());
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener('abort', onAbort);
      fn();
    };

    ctx.signal.addEventListener('abort', onAbort, { once: true });
    output.on('close', () => finish(resolve));
    output.on('error', (err) =>
      finish(() => reject(engineError(err, 'Could not write the ZIP archive.'))),
    );
    archive.on('error', (err: ArchiverError) =>
      finish(() => reject(engineError(err, 'Could not build the ZIP archive.'))),
    );
    archive.on('warning', (err: ArchiverError) => ctx.log('archiver warning', err));

    archive.pipe(output);
    archive.directory(srcDir, false);
    archive
      .finalize()
      .catch((err: unknown) =>
        finish(() => reject(engineError(err, 'Could not build the ZIP archive.'))),
      );
  });
}

// ---------------------------------------------------------------------------
// tar / tar.gz (native to the `tar` package — gzip is a flag, not a wrapper)
// ---------------------------------------------------------------------------

async function extractTar(
  archivePath: string,
  destDir: string,
  ctx: ConvertContext,
): Promise<void> {
  const names: string[] = [];
  try {
    await tar.list({
      file: archivePath,
      onentry: (entry: ReadEntry) => {
        names.push(entry.path);
      },
    });
  } catch (err) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: 'This tar archive could not be read; it may be corrupt.',
      detail: err instanceof Error ? err.message : String(err),
      retryable: false,
      cause: err,
    });
  }
  assertAllSafe(destDir, names);
  throwIfAborted(ctx.signal);
  await fs.promises.mkdir(destDir, { recursive: true });
  await tar.extract({
    file: archivePath,
    cwd: destDir,
    strict: true,
    preservePaths: false,
  });
}

async function createTar(
  srcDir: string,
  archivePath: string,
  gzip: boolean,
): Promise<void> {
  const names = await fs.promises.readdir(srcDir);
  await tar.create({ file: archivePath, cwd: srcDir, gzip, portable: true }, names);
}

// ---------------------------------------------------------------------------
// tar.bz2 / tar.xz — bzip2/xz are single-stream compressors around a plain
// .tar, so we round-trip through a real .tar staged in the scratch dir and
// let 7za handle only the outer compression layer.
// ---------------------------------------------------------------------------

async function extractCompressedTar(
  archivePath: string,
  destDir: string,
  ctx: ConvertContext,
): Promise<void> {
  const tempDir = await mkdtemp(ctx.scratchDir, 'archive-unpack-');
  await sevenExtractFull(archivePath, tempDir, ctx.signal);
  const files = await fs.promises.readdir(tempDir);
  if (files.length !== 1) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: 'This archive does not contain a single compressed tar stream.',
      retryable: false,
    });
  }
  const rawTar = path.join(tempDir, files[0] as string);
  await extractTar(rawTar, destDir, ctx);
}

async function createCompressedTar(
  srcDir: string,
  archivePath: string,
  ctx: ConvertContext,
  codec: 'bzip2' | 'xz',
): Promise<void> {
  const tempDir = await mkdtemp(ctx.scratchDir, 'archive-pack-');
  const rawTar = path.join(tempDir, 'archive.tar');
  await createTar(srcDir, rawTar, false);
  throwIfAborted(ctx.signal);
  await sevenAdd(archivePath, rawTar, codec, ctx.signal);
}

// ---------------------------------------------------------------------------
// 7z
// ---------------------------------------------------------------------------

async function extractSevenZip(
  archivePath: string,
  destDir: string,
  ctx: ConvertContext,
): Promise<void> {
  const names = await sevenList(archivePath, ctx.signal);
  assertAllSafe(destDir, names);
  await fs.promises.mkdir(destDir, { recursive: true });
  await sevenExtractFull(archivePath, destDir, ctx.signal);
}

async function createSevenZip(
  srcDir: string,
  archivePath: string,
  ctx: ConvertContext,
): Promise<void> {
  const entries = await fs.promises.readdir(srcDir);
  const sources =
    entries.length > 0 ? entries.map((e) => path.join(srcDir, e)) : [srcDir];
  await sevenAdd(archivePath, sources, '7z', ctx.signal);
}

// ---------------------------------------------------------------------------
// public entry points
// ---------------------------------------------------------------------------

export async function extractToDir(
  format: RepackFormat,
  archivePath: string,
  destDir: string,
  ctx: ConvertContext,
): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true });
  switch (format) {
    case 'zip':
      return extractZip(archivePath, destDir, ctx);
    case 'tar':
    case 'tar.gz':
      return extractTar(archivePath, destDir, ctx);
    case 'tar.bz2':
    case 'tar.xz':
      return extractCompressedTar(archivePath, destDir, ctx);
    case '7z':
      return extractSevenZip(archivePath, destDir, ctx);
    default: {
      const exhaustive: never = format;
      throw new Error(`Unhandled repack format: ${exhaustive as string}`);
    }
  }
}

export async function createFromDir(
  format: RepackFormat,
  srcDir: string,
  archivePath: string,
  ctx: ConvertContext,
): Promise<void> {
  switch (format) {
    case 'zip':
      return createZip(srcDir, archivePath, ctx);
    case 'tar':
      return createTar(srcDir, archivePath, false);
    case 'tar.gz':
      return createTar(srcDir, archivePath, true);
    case 'tar.bz2':
      return createCompressedTar(srcDir, archivePath, ctx, 'bzip2');
    case 'tar.xz':
      return createCompressedTar(srcDir, archivePath, ctx, 'xz');
    case '7z':
      return createSevenZip(srcDir, archivePath, ctx);
    default: {
      const exhaustive: never = format;
      throw new Error(`Unhandled repack format: ${exhaustive as string}`);
    }
  }
}

export { mkdtemp };
