import { CATEGORY_ORDER, FORMAT_BY_ALIAS, FORMAT_BY_ID, FORMATS } from '@core/formats';
import { ConverterRegistry } from '@core/registry';
import type { Availability } from '@core/types';
import { describe, expect, it } from 'vitest';
import { fake } from '../support/fake-converter';

describe('ConverterRegistry — behaviour', () => {
  it('throws on a duplicate converter id', () => {
    const registry = new ConverterRegistry();
    registry.register(fake('dup', ['jpeg'], ['png']));
    expect(() => registry.register(fake('dup', ['png'], ['jpeg']))).toThrow(/duplicate/i);
  });

  it('throws when a converter declares a format that does not exist', () => {
    const registry = new ConverterRegistry();
    expect(() => registry.register(fake('bad', ['not-a-real-format'], ['png']))).toThrow(
      /unknown format/i,
    );
  });

  it('accepts a converter whose inputs/outputs are all real format ids', () => {
    const registry = new ConverterRegistry();
    expect(() => registry.register(fake('ok', ['jpeg'], ['png']))).not.toThrow();
  });

  it('refreshAvailability() populates availability and bumps graphVersion on change', async () => {
    const registry = new ConverterRegistry();
    let available = false;
    registry.register(
      fake(
        'flaky',
        ['jpeg'],
        ['png'],
        {},
        { availability: async () => ({ available, reason: 'off' }) as Availability },
      ),
    );

    const v0 = registry.graphVersion;
    await registry.refreshAvailability();
    expect(registry.availableConverters()).toHaveLength(0);
    const v1 = registry.graphVersion;
    expect(v1).toBeGreaterThan(v0);

    available = true;
    await registry.refreshAvailability();
    expect(registry.availableConverters()).toHaveLength(1);
    const v2 = registry.graphVersion;
    expect(v2).toBeGreaterThan(v1);

    // No change -> no bump.
    await registry.refreshAvailability();
    expect(registry.graphVersion).toBe(v2);
  });

  it('treats a throwing availability() as unavailable rather than failing the refresh', async () => {
    const registry = new ConverterRegistry();
    registry.register(
      fake(
        'throws',
        ['jpeg'],
        ['png'],
        {},
        {
          availability: async () => {
            throw new Error('boom');
          },
        },
      ),
    );
    await expect(registry.refreshAvailability()).resolves.toBeUndefined();
    expect(registry.getAvailability('throws')?.available).toBe(false);
    expect(registry.availableConverters()).toHaveLength(0);
  });

  it('availableConverters() only returns converters marked available', async () => {
    const registry = new ConverterRegistry();
    registry.register(fake('yes', ['jpeg'], ['png']));
    registry.register(
      fake(
        'no',
        ['png'],
        ['webp'],
        {},
        { availability: async () => ({ available: false, reason: 'nope' }) },
      ),
    );
    await registry.refreshAvailability();
    expect(registry.availableConverters().map((c) => c.id)).toEqual(['yes']);
  });
});

describe('formats.ts — registry invariants (oracle for the real ~94-format table)', () => {
  it('every format id is unique', () => {
    const ids = FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('aliases never collide with a canonical format id', () => {
    const ids = new Set(FORMATS.map((f) => f.id));
    for (const f of FORMATS) {
      for (const alias of f.aliases ?? []) {
        expect(ids.has(alias)).toBe(false);
      }
    }
  });

  it('every extension maps to exactly one format', () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const f of FORMATS) {
      for (const ext of f.extensions) {
        const existing = owner.get(ext);
        if (existing && existing !== f.id) {
          collisions.push(`"${ext}" claimed by both "${existing}" and "${f.id}"`);
        } else {
          owner.set(ext, f.id);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('every binary format has at least one magic signature', () => {
    const missing = FORMATS.filter(
      (f) => f.binary && (!f.magic || f.magic.length === 0),
    ).map((f) => f.id);
    expect(missing).toEqual([]);
  });

  it('every format category is one of the declared FormatCategory values', () => {
    const valid = new Set(CATEGORY_ORDER);
    for (const f of FORMATS) {
      expect(valid.has(f.category)).toBe(true);
    }
  });

  it('FORMAT_BY_ID contains every format exactly once', () => {
    expect(FORMAT_BY_ID.size).toBe(FORMATS.length);
    for (const f of FORMATS) {
      expect(FORMAT_BY_ID.get(f.id)).toBe(f);
    }
  });

  it('FORMAT_BY_ALIAS resolves every id, alias and extension to a real format', () => {
    for (const [key, id] of FORMAT_BY_ALIAS) {
      expect(FORMAT_BY_ID.has(id)).toBe(true);
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('magic signatures use valid offset/hex/mask shapes', () => {
    for (const f of FORMATS) {
      for (const sig of f.magic ?? []) {
        expect(sig.offset).toBeGreaterThanOrEqual(0);
        expect(sig.bytes).toMatch(/^[0-9a-f]+$/);
        expect(sig.bytes.length % 2).toBe(0);
        if (sig.mask) {
          expect(sig.mask.length).toBe(sig.bytes.length);
          expect(sig.mask).toMatch(/^[0-9a-f]+$/);
        }
      }
    }
  });
});
