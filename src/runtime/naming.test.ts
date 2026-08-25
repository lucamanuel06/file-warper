import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeOutputPath, createReservation, sanitizeBasename } from './naming';

describe('sanitizeBasename', () => {
  it('replaces forbidden characters', () => {
    expect(sanitizeBasename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('drops ASCII control characters', () => {
    expect(
      sanitizeBasename(`a${String.fromCharCode(1)}b${String.fromCharCode(31)}c`),
    ).toBe('abc');
  });

  it('trims trailing dots and spaces', () => {
    expect(sanitizeBasename('report...  ')).toBe('report');
  });

  it('prefixes reserved Windows device names', () => {
    expect(sanitizeBasename('CON')).toBe('_CON');
    expect(sanitizeBasename('lpt1')).toBe('_lpt1');
  });

  it('falls back to "file" for an empty result', () => {
    expect(sanitizeBasename('...')).toBe('file');
  });

  it('clamps to 255 bytes without splitting a multi-byte character', () => {
    const name = 'é'.repeat(200); // 2 bytes each in UTF-8 -> 400 bytes
    const out = sanitizeBasename(name);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(255);
    expect(out).toBe(Buffer.from(out, 'utf8').toString('utf8')); // round-trips cleanly
  });
});

describe('computeOutputPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-naming-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to {basename}.{ext} alongside the input', () => {
    const input = path.join(dir, 'photo.heic');
    const out = computeOutputPath({
      inputPath: input,
      target: 'png',
      location: { mode: 'alongside' },
      reservation: createReservation(),
    });
    expect(out).toBe(path.join(dir, 'photo.png'));
  });

  it('suffixes on collision, matching Finder: "photo (1).png"', () => {
    const input = path.join(dir, 'photo.heic');
    fs.writeFileSync(path.join(dir, 'photo.png'), '');
    const out = computeOutputPath({
      inputPath: input,
      target: 'png',
      location: { mode: 'alongside' },
      reservation: createReservation(),
    });
    expect(out).toBe(path.join(dir, 'photo (1).png'));
  });

  it('reserves in memory so two racing jobs never collide on an unwritten name', () => {
    // a.heic and a.jpg both converge on a.png — neither exists on disk yet,
    // so only the in-memory reservation set can catch this race.
    const reservation = createReservation();
    const first = computeOutputPath({
      inputPath: path.join(dir, 'a.heic'),
      target: 'png',
      location: { mode: 'alongside' },
      reservation,
    });
    const second = computeOutputPath({
      inputPath: path.join(dir, 'a.jpg'),
      target: 'png',
      location: { mode: 'alongside' },
      reservation,
    });
    expect(first).toBe(path.join(dir, 'a.png'));
    expect(second).toBe(path.join(dir, 'a (1).png'));
  });

  it('never lets the computed output destroy the input, even with collision: "overwrite"', () => {
    const input = path.join(dir, 'photo.png');
    const out = computeOutputPath({
      inputPath: input,
      target: 'png',
      location: { mode: 'alongside' },
      collision: 'overwrite',
      reservation: createReservation(),
    });
    expect(out).not.toBe(input);
    expect(out).toBe(path.join(dir, 'photo (1).png'));
  });

  it('collision "skip" returns "" when the name is already taken', () => {
    fs.writeFileSync(path.join(dir, 'photo.png'), '');
    const out = computeOutputPath({
      inputPath: path.join(dir, 'photo.heic'),
      target: 'png',
      location: { mode: 'alongside' },
      collision: 'skip',
      reservation: createReservation(),
    });
    expect(out).toBe('');
  });

  it('collision "timestamp" embeds a fixed timestamp', () => {
    const out = computeOutputPath({
      inputPath: path.join(dir, 'photo.heic'),
      target: 'png',
      location: { mode: 'alongside' },
      collision: 'timestamp',
      reservation: createReservation(),
      now: new Date('2026-08-25T14:12:33').getTime(),
    });
    expect(out).toBe(path.join(dir, 'photo-20260825-141233.png'));
  });

  it('"mirror" reproduces the folder-drop tree shape under the target root', () => {
    const sourceRoot = path.join(dir, 'src');
    const nested = path.join(sourceRoot, 'sub', 'photo.heic');
    const out = computeOutputPath({
      inputPath: nested,
      target: 'png',
      location: { mode: 'mirror', root: path.join(dir, 'dst'), sourceRoot },
      reservation: createReservation(),
    });
    expect(out).toBe(path.join(dir, 'dst', 'sub', 'photo.png'));
  });

  it('"fixed" always writes into the given directory', () => {
    const out = computeOutputPath({
      inputPath: path.join(dir, 'a', 'photo.heic'),
      target: 'png',
      location: { mode: 'fixed', dir: path.join(dir, 'flat') },
      reservation: createReservation(),
    });
    expect(out).toBe(path.join(dir, 'flat', 'photo.png'));
  });
});
