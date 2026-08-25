/**
 * @warp/core — output path resolution.
 *
 * Turns `(inputPath, target, location)` into a concrete output path,
 * honouring the collision policy and never letting a computed output path
 * equal the input path (see docs/spec-core-architecture.md §5).
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { extensionFor, FORMAT_BY_ALIAS } from './formats';
import type { CollisionPolicy, FormatId, OutputLocation } from './types';

const MAX_FILENAME_BYTES = 255;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars from filenames is the point.
const FORBIDDEN_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const TRAILING_DOTS_SPACES = /[. ]+$/;

const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function reservationKey(path: string): string {
  return CASE_INSENSITIVE_FS ? path.toLowerCase() : path;
}

function samePath(a: string, b: string): boolean {
  return reservationKey(resolve(a)) === reservationKey(resolve(b));
}

function isTakenOrExists(taken: Set<string>, candidate: string): boolean {
  return taken.has(reservationKey(candidate)) || existsSync(candidate);
}

function reserve(taken: Set<string>, candidate: string): void {
  taken.add(reservationKey(candidate));
}

/**
 * Strip a filename's *known* extension, matching longest-first so compound
 * extensions come off whole (`archive.tar.gz` -> `archive`, not
 * `archive.tar`). Falls back to stripping only the last dot-segment for
 * filenames whose extension isn't one we recognise.
 */
function stemOf(filename: string): string {
  const lowerParts = filename.toLowerCase().split('.');
  const parts = filename.split('.');
  for (let i = 1; i < lowerParts.length; i++) {
    const candidate = lowerParts.slice(i).join('.');
    if (FORMAT_BY_ALIAS.has(candidate)) return parts.slice(0, i).join('.');
  }
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

function sanitizeStem(stem: string): string {
  let s = stem.replace(FORBIDDEN_CHARS, '_').replace(TRAILING_DOTS_SPACES, '');
  if (s.length === 0) s = 'file';
  if (RESERVED_NAMES.has(s.toUpperCase())) s = `_${s}`;
  return s;
}

function isUtf8ContinuationByte(b: number): boolean {
  return (b & 0b11000000) === 0b10000000;
}

function truncateToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const full = Buffer.from(s, 'utf8');
  if (full.length <= maxBytes) return s;

  // `full[end]` is the first EXCLUDED byte. If it's a continuation byte, the
  // cut lands inside a multi-byte character — back up to that character's
  // start so we never split it.
  let end = maxBytes;
  while (end > 0 && isUtf8ContinuationByte(full[end] as number)) end--;
  return full.subarray(0, end).toString('utf8');
}

/** Clamps the FULL filename (stem + `.ext`) to 255 bytes, not characters. */
function buildFilename(stem: string, ext: string): string {
  const suffix = `.${ext}`;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = MAX_FILENAME_BYTES - suffixBytes;
  if (budget <= 0) return truncateToBytes(stem + suffix, MAX_FILENAME_BYTES);
  return truncateToBytes(stem, budget) + suffix;
}

function withAttempt(stem: string, attempt: number): string {
  // Finder-style: `photo`, `photo 2`, `photo 3` — never `photo 1`.
  return attempt === 0 ? stem : `${stem} ${attempt + 1}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTimestamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function resolveDir(inputPath: string, location: OutputLocation): string {
  switch (location.mode) {
    case 'alongside':
      return dirname(inputPath);
    case 'fixed':
      return location.dir;
    case 'mirror': {
      const rel = relative(location.sourceRoot, dirname(inputPath));
      return join(location.root, rel);
    }
    default:
      return dirname(inputPath);
  }
}

/**
 * Resolve where a conversion should write its output.
 *
 * Reserves the chosen path in `taken` (mutated) alongside the filesystem
 * check — a naive `existsSync` alone races when two inputs converge on the
 * same output name. Returns `null` only under `'skip'` when the target is
 * already taken; every other policy always resolves to a path.
 *
 * If the computed output would equal `inputPath`, `'suffix'` is forced
 * regardless of `policy` — a conversion must never destroy its source.
 */
export function resolveOutputPath(
  inputPath: string,
  target: FormatId,
  location: OutputLocation,
  taken: Set<string>,
  policy: CollisionPolicy = 'suffix',
  now: Date = new Date(),
): string | null {
  const dir = resolveDir(inputPath, location);
  const stem = sanitizeStem(stemOf(basename(inputPath)));
  const ext = extensionFor(target);

  const build = (candidateStem: string): string =>
    join(dir, buildFilename(sanitizeStem(candidateStem), ext));

  const naive = build(stem);
  const effectivePolicy: CollisionPolicy = samePath(naive, inputPath) ? 'suffix' : policy;

  switch (effectivePolicy) {
    case 'overwrite': {
      reserve(taken, naive);
      return naive;
    }
    case 'skip': {
      if (isTakenOrExists(taken, naive)) return null;
      reserve(taken, naive);
      return naive;
    }
    case 'timestamp': {
      const stamped = `${stem}-${formatTimestamp(now)}`;
      let candidate = build(stamped);
      let n = 1;
      while (isTakenOrExists(taken, candidate)) {
        candidate = build(`${stamped}-${n}`);
        n++;
      }
      reserve(taken, candidate);
      return candidate;
    }
    default: {
      let attempt = 0;
      let candidate = build(withAttempt(stem, attempt));
      while (isTakenOrExists(taken, candidate)) {
        attempt++;
        if (attempt > 100_000) {
          throw new Error(`resolveOutputPath: exhausted suffix attempts for "${stem}"`);
        }
        candidate = build(withAttempt(stem, attempt));
      }
      reserve(taken, candidate);
      return candidate;
    }
  }
}
