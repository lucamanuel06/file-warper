import { Router } from '@core/graph';
import type { Converter } from '@core/types';
import { describe, expect, it } from 'vitest';
import { fake } from '../support/fake-converter';

class FakeRegistry {
  graphVersion = 0;
  private converters: Converter[];

  constructor(converters: Converter[]) {
    this.converters = converters;
  }

  availableConverters(): Converter[] {
    return this.converters;
  }

  setConverters(converters: Converter[]): void {
    this.converters = converters;
    this.graphVersion++;
  }
}

describe('Router', () => {
  it('routesFrom() memoises per (src, graphVersion) — same graph instance until version bumps', () => {
    const registry = new FakeRegistry([fake('a', ['jpeg'], ['png'])]);
    const router = new Router(registry);

    const first = router.routesFrom('jpeg');
    const second = router.routesFrom('jpeg');
    expect(second).toBe(first); // identical Map instance -> cache hit

    registry.setConverters([fake('a', ['jpeg'], ['png']), fake('b', ['jpeg'], ['webp'])]);
    const third = router.routesFrom('jpeg');
    expect(third).not.toBe(first);
    expect(third.has('webp')).toBe(true);
  });

  it('targetsFor() sorts same-category first, then lossless, then popularity, then id', () => {
    const registry = new FakeRegistry([
      fake('toDocx', ['jpeg'], ['docx'], { retention: 1 }), // document, lossless
      fake('toLossyPng', ['jpeg'], ['png'], { retention: 0.5 }), // image, lossy
      fake('toWebp', ['jpeg'], ['webp'], { retention: 1 }), // image, lossless
    ]);
    const router = new Router(registry);
    const targets = router.targetsFor('jpeg');

    // Same-category (image) targets sort before the document target,
    // and within image, the lossless one (webp) sorts before the lossy one (png).
    expect(targets.indexOf('webp')).toBeLessThan(targets.indexOf('png'));
    expect(targets.indexOf('png')).toBeLessThan(targets.indexOf('docx'));
  });

  it('targetsForAll() computes the intersection as common and the rest as partial', () => {
    const registry = new FakeRegistry([
      fake('jpegToPng', ['jpeg'], ['png']),
      fake('jpegToWebp', ['jpeg'], ['webp']),
      fake('bmpToPng', ['bmp'], ['png']),
    ]);
    const router = new Router(registry);
    const set = router.targetsForAll(['jpeg', 'bmp']);

    expect(set.common).toEqual(['png']);
    expect(set.partial.webp).toEqual(['jpeg']);
    expect(set.partial.png).toBeUndefined(); // png is common, not partial
  });

  it('targetsForAll() never lists a format reachable from zero of the selected inputs', () => {
    const registry = new FakeRegistry([fake('jpegToPng', ['jpeg'], ['png'])]);
    const router = new Router(registry);
    const set = router.targetsForAll(['jpeg']);
    expect(Object.keys(set.partial)).not.toContain('gif');
  });

  it('fallbackFor() exposes the runner-up edge via the current graph', () => {
    const registry = new FakeRegistry([
      fake('cheap', ['jpeg'], ['png'], { retention: 1 }),
      fake('expensive', ['jpeg'], ['png'], { retention: 0.5 }),
    ]);
    const router = new Router(registry);
    expect(router.fallbackFor('jpeg', 'png')?.converterId).toBe('expensive');
  });

  it('clamps maxHops to the hard ceiling', () => {
    const registry = new FakeRegistry([
      fake('c1', ['jpeg'], ['png']),
      fake('c2', ['png'], ['webp']),
      fake('c3', ['webp'], ['gif']),
      fake('c4', ['gif'], ['bmp']),
      fake('c5', ['bmp'], ['tiff']),
    ]);
    const router = new Router(registry, { maxHops: 999 });
    expect(router.routesFrom('jpeg').has('bmp')).toBe(true); // 4 hops
    expect(router.routesFrom('jpeg').has('tiff')).toBe(false); // 5 hops, beyond the ceiling
  });
});
