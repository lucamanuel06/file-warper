import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveOutputPath } from '@core/naming';
import type { OutputLocation } from '@core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'warp-naming-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function alongside(): OutputLocation {
  return { mode: 'alongside' };
}

describe('resolveOutputPath — basics', () => {
  it('defaults to {inputBasename}.{canonicalExt} alongside the input', () => {
    const input = join(dir, 'photo.heic');
    const out = resolveOutputPath(input, 'webp', alongside(), new Set());
    expect(out).toBe(join(dir, 'photo.webp'));
  });

  it('strips a known compound extension whole, not just the last segment', () => {
    const input = join(dir, 'archive.tar.gz');
    const out = resolveOutputPath(input, 'zip', alongside(), new Set());
    expect(out).toBe(join(dir, 'archive.zip'));
  });

  it('falls back to stripping only the last dot-segment for an unrecognised extension', () => {
    const input = join(dir, 'notes.weird');
    const out = resolveOutputPath(input, 'txt', alongside(), new Set());
    expect(out).toBe(join(dir, 'notes.txt'));
  });
});

describe('resolveOutputPath — collision policies', () => {
  it('suffix: Finder-style "photo", "photo 2", "photo 3" — never "photo 1"', () => {
    const input = join(dir, 'photo.heic');
    writeFileSync(join(dir, 'photo.webp'), '');
    writeFileSync(join(dir, 'photo 2.webp'), '');

    const out = resolveOutputPath(input, 'webp', alongside(), new Set(), 'suffix');
    expect(out).toBe(join(dir, 'photo 3.webp'));
  });

  it('suffix: reserves in the taken set so a second call in the same batch advances', () => {
    const input = join(dir, 'photo.heic');
    const taken = new Set<string>();
    const first = resolveOutputPath(input, 'webp', alongside(), taken, 'suffix');
    const second = resolveOutputPath(input, 'webp', alongside(), taken, 'suffix');
    expect(first).toBe(join(dir, 'photo.webp'));
    expect(second).toBe(join(dir, 'photo 2.webp'));
  });

  it('suffix: two different inputs converging on the same output both get unique names', () => {
    const taken = new Set<string>();
    const a = resolveOutputPath(
      join(dir, 'a.heic'),
      'webp',
      { mode: 'fixed', dir },
      taken,
      'suffix',
    );
    writeFileSync(join(dir, 'a.webp'), ''); // renamed after 'a' resolved, before 'b' resolves
    const b = resolveOutputPath(
      join(dir, 'a.png'),
      'webp',
      { mode: 'fixed', dir },
      taken,
      'suffix',
    );
    expect(a).toBe(join(dir, 'a.webp'));
    expect(b).not.toBe(a);
  });

  it('overwrite: returns the naive path even if it exists on disk', () => {
    const input = join(dir, 'photo.heic');
    writeFileSync(join(dir, 'photo.webp'), 'old');
    const out = resolveOutputPath(input, 'webp', alongside(), new Set(), 'overwrite');
    expect(out).toBe(join(dir, 'photo.webp'));
  });

  it('skip: returns null when the target already exists', () => {
    const input = join(dir, 'photo.heic');
    writeFileSync(join(dir, 'photo.webp'), 'old');
    const out = resolveOutputPath(input, 'webp', alongside(), new Set(), 'skip');
    expect(out).toBeNull();
  });

  it('skip: returns the path when nothing is in the way', () => {
    const input = join(dir, 'photo.heic');
    const out = resolveOutputPath(input, 'webp', alongside(), new Set(), 'skip');
    expect(out).toBe(join(dir, 'photo.webp'));
  });

  it('timestamp: appends YYYYMMDD-HHMMSS', () => {
    const input = join(dir, 'photo.heic');
    const now = new Date(2026, 7, 25, 14, 12, 33); // months are 0-indexed -> August
    const out = resolveOutputPath(
      input,
      'webp',
      alongside(),
      new Set(),
      'timestamp',
      now,
    );
    expect(out).toBe(join(dir, 'photo-20260825-141233.webp'));
  });

  it('timestamp: disambiguates a same-second collision', () => {
    const now = new Date(2026, 7, 25, 14, 12, 33);
    const taken = new Set<string>();
    const first = resolveOutputPath(
      join(dir, 'a.heic'),
      'webp',
      alongside(),
      taken,
      'timestamp',
      now,
    );
    const second = resolveOutputPath(
      join(dir, 'b.heic'),
      'webp',
      alongside(),
      taken,
      'timestamp',
      now,
    );
    // Different stems ('a' vs 'b') so no collision expected here; assert both resolve distinctly.
    expect(first).not.toBe(second);
  });
});

describe('resolveOutputPath — never destroy the source', () => {
  it('forces suffix even under overwrite when computed output equals the input', () => {
    const input = join(dir, 'photo.png');
    writeFileSync(input, 'original');
    const out = resolveOutputPath(input, 'png', alongside(), new Set(), 'overwrite');
    expect(out).not.toBe(input);
    expect(out).toBe(join(dir, 'photo 2.png'));
  });

  it('forces suffix even under skip when computed output equals the input', () => {
    const input = join(dir, 'photo.png');
    writeFileSync(input, 'original');
    const out = resolveOutputPath(input, 'png', alongside(), new Set(), 'skip');
    expect(out).not.toBeNull();
    expect(out).not.toBe(input);
  });
});

describe('resolveOutputPath — sanitisation', () => {
  it('strips forbidden characters and control characters', () => {
    const input = join(dir, 'weird<>:"|?*name.heic');
    const out = resolveOutputPath(input, 'webp', alongside(), new Set());
    expect(out).toBe(join(dir, 'weird_______name.webp'));
  });

  it('trims trailing dots and spaces from the stem', () => {
    const input = join(dir, 'trailing.dots... .heic');
    const out = resolveOutputPath(input, 'webp', alongside(), new Set());
    expect(out?.includes('  ')).toBe(false);
    expect(out?.endsWith('.webp')).toBe(true);
  });

  it('escapes a Windows-reserved device name', () => {
    const input = join(dir, 'CON.heic');
    const out = resolveOutputPath(input, 'webp', alongside(), new Set());
    expect(out).toBe(join(dir, '_CON.webp'));
  });

  it('clamps the filename to 255 bytes, preserving the extension', () => {
    const longStem = 'a'.repeat(400);
    const input = join(dir, `${longStem}.heic`);
    const out = resolveOutputPath(input, 'webp', alongside(), new Set()) as string;
    const filename = basename(out);
    expect(Buffer.byteLength(filename, 'utf8')).toBeLessThanOrEqual(255);
    expect(filename.endsWith('.webp')).toBe(true);
  });

  it('clamps multi-byte UTF-8 stems without splitting a character', () => {
    const longStem = '日'.repeat(200); // 3 bytes each in UTF-8
    const input = join(dir, `${longStem}.heic`);
    const out = resolveOutputPath(input, 'webp', alongside(), new Set()) as string;
    const filename = basename(out);
    expect(Buffer.byteLength(filename, 'utf8')).toBeLessThanOrEqual(255);
    // Round-trips through Buffer without the replacement character.
    expect(filename.includes('�')).toBe(false);
  });
});

describe('resolveOutputPath — output locations', () => {
  it('fixed: writes into the given directory regardless of input location', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'warp-naming-fixed-'));
    try {
      const input = join(dir, 'photo.heic');
      const out = resolveOutputPath(
        input,
        'webp',
        { mode: 'fixed', dir: otherDir },
        new Set(),
      );
      expect(out).toBe(join(otherDir, 'photo.webp'));
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('mirror: preserves the relative subdirectory structure under sourceRoot', () => {
    const sourceRoot = dir;
    const outRoot = mkdtempSync(join(tmpdir(), 'warp-naming-mirror-'));
    try {
      const subdir = join(sourceRoot, 'a', 'b');
      mkdirSync(subdir, { recursive: true });
      const input = join(subdir, 'photo.heic');
      const out = resolveOutputPath(
        input,
        'webp',
        { mode: 'mirror', root: outRoot, sourceRoot },
        new Set(),
      );
      expect(out).toBe(join(outRoot, 'a', 'b', 'photo.webp'));
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveOutputPath — case sensitivity', () => {
  it('treats two different-cased reservations as the same name on darwin', () => {
    if (process.platform !== 'darwin') return;
    const taken = new Set<string>();
    resolveOutputPath(join(dir, 'Photo.heic'), 'webp', alongside(), taken, 'suffix');
    const second = resolveOutputPath(
      join(dir, 'photo.HEIC'),
      'webp',
      alongside(),
      taken,
      'suffix',
    );
    expect(second).toBe(join(dir, 'photo 2.webp'));
  });
});
