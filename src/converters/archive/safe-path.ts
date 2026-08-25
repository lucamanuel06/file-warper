/**
 * Zip-slip guard shared by every extraction path in this directory (zip,
 * tar/tar.gz/tar.bz2/tar.xz, 7z, rar, cab, iso). An entry path that would
 * resolve outside the destination directory aborts the WHOLE operation —
 * never skip-and-continue.
 */

import path from 'node:path';
import { ConversionError } from '@core/types';

/**
 * Throws if `entryName` (as read from an archive) would write outside
 * `destDir` once resolved. Call this BEFORE writing/creating anything for
 * the entry.
 */
export function assertSafeEntryPath(destDir: string, entryName: string): string {
  const resolvedDest = path.resolve(destDir);
  const resolvedEntry = path.resolve(resolvedDest, entryName);
  if (
    resolvedEntry !== resolvedDest &&
    !resolvedEntry.startsWith(resolvedDest + path.sep)
  ) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: 'This archive contains an unsafe file path and was not extracted.',
      detail: `entry "${entryName}" resolves outside the destination directory`,
      retryable: false,
    });
  }
  return resolvedEntry;
}

/** Validates every name in one pass; throws on the first unsafe entry. */
export function assertAllSafe(destDir: string, entryNames: Iterable<string>): void {
  for (const name of entryNames) {
    assertSafeEntryPath(destDir, name);
  }
}
