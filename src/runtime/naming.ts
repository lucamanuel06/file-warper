/**
 * TEMPORARY STUB — replace with `@core/naming` once W1 lands (see
 * docs/PLAN.md, `src/core/naming.ts` is W1-owned). Output-path computation
 * needs to exist for the scheduler to run at all, so this is a compact local
 * implementation of docs/spec-core-architecture.md §5 "Output naming".
 */

import fs from 'node:fs';
import path from 'node:path';
import { extensionFor } from '@core/formats';
import type { CollisionPolicy, FormatId, OutputLocation } from '@core/types';

const FORBIDDEN_CHARS = /[<>:"/\\|?*]/g;
const TRAILING_DOTS_SPACES = /[. ]+$/;
const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

const ASCII_CONTROL_CEILING = 32;

/** Drops ASCII control chars without embedding one as a literal in source. */
function stripControlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? ASCII_CONTROL_CEILING;
    if (code >= ASCII_CONTROL_CEILING) out += ch;
  }
  return out;
}

/** Strips forbidden/control chars and trailing dots, rejects reserved device names, clamps to 255 bytes. */
export function sanitizeBasename(name: string): string {
  let out = stripControlChars(name)
    .replace(FORBIDDEN_CHARS, '_')
    .replace(TRAILING_DOTS_SPACES, '');
  if (out.length === 0) out = 'file';
  if (RESERVED_DEVICE_NAMES.has(out.toUpperCase())) out = `_${out}`;

  if (Buffer.byteLength(out, 'utf8') > 255) {
    // Build up whole Unicode code points (not raw bytes) so a multi-byte
    // sequence is never split mid-character.
    let clamped = '';
    let bytes = 0;
    for (const codePoint of out) {
      const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
      if (bytes + codePointBytes > 255) break;
      clamped += codePoint;
      bytes += codePointBytes;
    }
    out = clamped;
  }
  return out;
}

function normalizeForCompare(p: string): string {
  return process.platform === 'darwin' || process.platform === 'win32'
    ? p.toLowerCase()
    : p;
}

/**
 * In-memory reservation set, checked alongside the filesystem so two racing
 * jobs converging on the same name never both pass a naive `existsSync`.
 */
export interface NameReservation {
  has(p: string): boolean;
  add(p: string): void;
}

export function createReservation(): NameReservation {
  const seen = new Set<string>();
  return {
    has: (p) => seen.has(normalizeForCompare(path.resolve(p))),
    add: (p) => {
      seen.add(normalizeForCompare(path.resolve(p)));
    },
  };
}

function targetDir(inputPath: string, location: OutputLocation): string {
  if (location.mode === 'alongside') return path.dirname(inputPath);
  if (location.mode === 'fixed') return location.dir;
  const rel = path.relative(location.sourceRoot, path.dirname(inputPath));
  return path.join(location.root, rel);
}

function existsAnywhere(p: string, reservation: NameReservation): boolean {
  if (reservation.has(p)) return true;
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export interface OutputNameRequest {
  readonly inputPath: string;
  readonly target: FormatId;
  readonly location: OutputLocation;
  readonly collision?: CollisionPolicy;
  readonly reservation: NameReservation;
  readonly now?: number;
}

/** Returns `''` only for `collision: 'skip'` when the name is already taken. */
export function computeOutputPath(req: OutputNameRequest): string {
  const dir = targetDir(req.inputPath, req.location);
  const ext = extensionFor(req.target);
  const base = sanitizeBasename(
    path.basename(req.inputPath, path.extname(req.inputPath)),
  );

  let candidate = path.join(dir, `${base}.${ext}`);
  let policy: CollisionPolicy = req.collision ?? 'suffix';
  const resolvedInput = normalizeForCompare(path.resolve(req.inputPath));
  const collidesWithInput = (p: string) =>
    normalizeForCompare(path.resolve(p)) === resolvedInput;

  // Never let the output destroy the source, regardless of the requested policy.
  if (collidesWithInput(candidate)) {
    policy = 'suffix';
  }

  if (policy === 'overwrite') {
    req.reservation.add(candidate);
    return candidate;
  }

  if (policy === 'timestamp') {
    candidate = path.join(
      dir,
      `${base}-${formatTimestamp(req.now ?? Date.now())}.${ext}`,
    );
    req.reservation.add(candidate);
    return candidate;
  }

  if (policy === 'skip') {
    if (existsAnywhere(candidate, req.reservation)) return '';
    req.reservation.add(candidate);
    return candidate;
  }

  // 'suffix' (default) — matches Finder: `photo.png`, `photo (1).png`, ...
  let n = 0;
  while (existsAnywhere(candidate, req.reservation) || collidesWithInput(candidate)) {
    n++;
    candidate = path.join(dir, `${base} (${n}).${ext}`);
  }
  req.reservation.add(candidate);
  return candidate;
}
