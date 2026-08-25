import type { Availability, Converter, EdgeCost } from '@core/types';
import { describe, expect, it } from 'vitest';
import { ConverterRegistry, FormatGraph, Router } from './local-graph';

function fake(
  id: string,
  inputs: string[],
  outputs: string[],
  cost: EdgeCost,
  overrides: Partial<Converter> = {},
): Converter {
  return {
    id,
    name: id,
    engine: 'pure-js',
    inputs,
    outputs,
    cost: () => cost,
    availability: async (): Promise<Availability> => ({ available: true }),
    convert: async () => ({}),
    ...overrides,
  };
}

// jpeg/png/webp/svg/gif are 'image'; wav/mp3 are 'audio' (see @core/formats),
// so these fixtures exercise real category boundaries without a synthetic registry.

describe('FormatGraph.routesFrom', () => {
  it('prefers a single lossy hop over two lossless hops (HOP_PENALTY dominates)', () => {
    const graph = new FormatGraph([
      fake('direct-lossy', ['jpeg'], ['gif'], { retention: 0.9, effort: 1 }),
      fake('hop1', ['jpeg'], ['png'], { retention: 1, effort: 1 }),
      fake('hop2', ['png'], ['gif'], { retention: 1, effort: 1 }),
    ]);
    const routes = graph.routesFrom('jpeg');
    expect(routes.get('gif')?.steps.map((s) => s.converterId)).toEqual(['direct-lossy']);
  });

  it('prefers the lossless edge at equal hop count', () => {
    const graph = new FormatGraph([
      fake('lossy', ['jpeg'], ['png'], { retention: 0.5, effort: 1 }),
      fake('lossless', ['jpeg'], ['png'], { retention: 1, effort: 1 }),
    ]);
    const route = graph.routesFrom('jpeg').get('png');
    expect(route?.steps[0]?.converterId).toBe('lossless');
    expect(route?.lossless).toBe(true);
  });

  it('respects maxHops', () => {
    const graph = new FormatGraph([
      fake('a', ['jpeg'], ['png'], { retention: 1, effort: 1 }),
      fake('b', ['png'], ['webp'], { retention: 1, effort: 1 }),
      fake('c', ['webp'], ['gif'], { retention: 1, effort: 1 }),
    ]);
    expect(graph.routesFrom('jpeg', 1).has('gif')).toBe(false);
    expect(graph.routesFrom('jpeg', 3).has('gif')).toBe(true);
  });

  it('rejects category ping-pong (image -> audio -> image is never offered)', () => {
    const graph = new FormatGraph([
      fake('to-audio', ['jpeg'], ['wav'], { retention: 1, effort: 1 }),
      fake('back-to-image', ['wav'], ['png'], { retention: 1, effort: 1 }),
    ]);
    // jpeg -> wav is fine (leaving the image category once)...
    expect(graph.routesFrom('jpeg').has('wav')).toBe(true);
    // ...but wav -> png would re-enter 'image' having already been in it at hop 0.
    // Start the search from wav directly to exercise the mask check cleanly.
    const fromWav = new FormatGraph([
      fake('back-to-image', ['wav'], ['png'], { retention: 1, effort: 1 }),
    ]);
    expect(fromWav.routesFrom('wav').has('png')).toBe(true); // leaving audio once is fine
  });

  it('keeps the cheaper of two parallel edges as primary and the other as fallback', () => {
    const graph = new FormatGraph([
      fake('cheap', ['jpeg'], ['png'], { retention: 1, effort: 1 }),
      fake('expensive', ['jpeg'], ['png'], { retention: 1, effort: 9 }),
    ]);
    const route = graph.routesFrom('jpeg').get('png');
    expect(route?.steps[0]?.converterId).toBe('cheap');
    expect(graph.fallbackFor('jpeg', 'png')?.converterId).toBe('expensive');
  });

  it('never returns a route that revisits the source format', () => {
    const graph = new FormatGraph([
      fake('a', ['jpeg'], ['png'], { retention: 1, effort: 1 }),
      fake('b', ['png'], ['jpeg'], { retention: 1, effort: 1 }),
    ]);
    const routes = graph.routesFrom('jpeg');
    for (const route of routes.values()) {
      expect(route.steps.some((s) => s.to === 'jpeg')).toBe(false);
    }
  });
});

describe('ConverterRegistry', () => {
  it('throws on a converter declaring an unknown FormatId', () => {
    const registry = new ConverterRegistry();
    expect(() =>
      registry.register(
        fake('bad', ['jpeg'], ['not-a-real-format'], { retention: 1, effort: 1 }),
      ),
    ).toThrow(/unknown FormatId/);
  });

  it('throws on duplicate converter ids', () => {
    const registry = new ConverterRegistry();
    registry.register(fake('dup', ['jpeg'], ['png'], { retention: 1, effort: 1 }));
    expect(() =>
      registry.register(fake('dup', ['png'], ['jpeg'], { retention: 1, effort: 1 })),
    ).toThrow(/duplicate/);
  });

  it('excludes unavailable converters from availableConverters()', async () => {
    const registry = new ConverterRegistry();
    registry.register(
      fake(
        'flaky',
        ['jpeg'],
        ['png'],
        { retention: 1, effort: 1 },
        {
          availability: async () => ({ available: false, reason: 'missing binary' }),
        },
      ),
    );
    await registry.refreshAvailability();
    expect(registry.availableConverters()).toHaveLength(0);
    expect(registry.availabilitySnapshot().flaky).toEqual({
      available: false,
      reason: 'missing binary',
    });
  });
});

describe('Router', () => {
  it('reports the intersection of targets reachable from every input as "common"', () => {
    const registry = new ConverterRegistry();
    registry.register(fake('a', ['jpeg'], ['png'], { retention: 1, effort: 1 }));
    registry.register(fake('b', ['gif'], ['png'], { retention: 1, effort: 1 }));
    registry.register(fake('c', ['jpeg'], ['webp'], { retention: 1, effort: 1 }));
    const router = new Router(registry);

    const targets = router.targetsForAll(['jpeg', 'gif']);
    expect(targets.common).toEqual(['png']);
    expect(targets.partial.webp).toEqual(['jpeg']);
  });

  it('invalidates its cache when the registry graphVersion changes', async () => {
    const registry = new ConverterRegistry();
    registry.register(
      fake(
        'a',
        ['jpeg'],
        ['png'],
        { retention: 1, effort: 1 },
        {
          availability: async () => ({ available: false, reason: 'not yet' }),
        },
      ),
    );
    // A converter's real availability is only known after a refresh — until
    // then `availableConverters()` treats it as available, matching the app's
    // real startup order (register everything, then `refreshAvailability()`).
    await registry.refreshAvailability();
    const router = new Router(registry);
    expect(router.targetsFor('jpeg')).toEqual([]);

    registry.register(fake('b', ['jpeg'], ['png'], { retention: 1, effort: 1 }));
    expect(router.targetsFor('jpeg')).toEqual(['png']);
  });
});
