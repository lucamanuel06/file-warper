/**
 * Thin wrapper around `node-7z` + `7zip-bin`'s vendored `7za` binary.
 *
 * Every converter in this directory that needs 7z/bz2/xz/cab/iso support
 * goes through here so the "is the binary actually usable" check and the
 * stream->Promise plumbing lives in one place.
 */

import fs from 'node:fs';
import type { Availability } from '@core/types';
import { ConversionError } from '@core/types';
import * as sevenBin from '7zip-bin';
import type { SevenZipDataEvent, SevenZipOptions, SevenZipStream } from 'node-7z';
import * as seven from 'node-7z';

/** `7za` ships with the exec bit stripped sometimes (npm/git can drop it). */
function ensureExecutable(binPath: string): void {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
  } catch {
    fs.chmodSync(binPath, 0o755);
  }
}

export async function sevenZipAvailability(): Promise<Availability> {
  const binPath = sevenBin.path7za;
  try {
    const stat = await fs.promises.stat(binPath);
    if (!stat.isFile()) {
      return {
        available: false,
        reason: 'The bundled 7-Zip binary is missing.',
        remedy: 'Reinstall File Warper to restore the bundled 7z engine.',
      };
    }
    ensureExecutable(binPath);
    await fs.promises.access(binPath, fs.constants.X_OK);
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason:
        err instanceof Error
          ? err.message
          : 'The bundled 7-Zip binary could not be used.',
      remedy: 'Reinstall File Warper to restore the bundled 7z engine.',
    };
  }
}

function toEngineError(err: Error): ConversionError {
  return new ConversionError({
    code: 'E_ENGINE',
    userMessage: 'The archive engine failed to process this file.',
    detail: err.message,
    retryable: false,
    cause: err,
  });
}

function cancelledError(): ConversionError {
  return new ConversionError({
    code: 'E_CANCELLED',
    userMessage: 'The conversion was cancelled.',
    retryable: false,
  });
}

/** Drains a node-7z stream (list/extractFull/add/...) into its `data` events. */
function drain(
  stream: SevenZipStream,
  signal?: AbortSignal,
): Promise<SevenZipDataEvent[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const events: SevenZipDataEvent[] = [];
    const onAbort = (): void => {
      cleanup();
      try {
        stream._childProcess?.kill();
      } catch {
        // best effort
      }
      reject(cancelledError());
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (data: SevenZipDataEvent) => events.push(data));
    stream.on('error', (err: Error) => {
      cleanup();
      reject(toEngineError(err));
    });
    stream.on('end', () => {
      cleanup();
      resolve(events);
    });
  });
}

function withBin(options?: SevenZipOptions): SevenZipOptions {
  return { ...options, $bin: sevenBin.path7za };
}

/** Lists archive entries; `data.file` is the relative path of each entry. */
export async function sevenList(
  archivePath: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const events = await drain(seven.list(archivePath, withBin()), signal);
  const names: string[] = [];
  for (const e of events) {
    if (typeof e.file === 'string' && e.file.length > 0) names.push(e.file);
  }
  return names;
}

export async function sevenExtractFull(
  archivePath: string,
  outputDir: string,
  signal?: AbortSignal,
): Promise<void> {
  await drain(seven.extractFull(archivePath, outputDir, withBin({ yes: true })), signal);
}

/** Creates/appends `sources` (absolute paths) into `archivePath`. */
export async function sevenAdd(
  archivePath: string,
  sources: string | readonly string[],
  archiveType: string,
  signal?: AbortSignal,
): Promise<void> {
  await drain(
    seven.add(archivePath, sources, withBin({ archiveType, recursive: true })),
    signal,
  );
}

/** Renames entries already inside `archivePath` (pairs of `[oldName, newName]`). */
export async function sevenRename(
  archivePath: string,
  pairs: ReadonlyArray<readonly [string, string]>,
  signal?: AbortSignal,
): Promise<void> {
  await drain(seven.rename(archivePath, pairs, withBin()), signal);
}
