import { FormatGraph, HARD_MAX_HOPS } from '@core/graph';
import { describe, expect, it } from 'vitest';
import { fake } from '../support/fake-converter';

describe('FormatGraph — routesFrom', () => {
  it('prefers a single lossy hop over two lossless hops (HOP_PENALTY dominates)', () => {
    const g = new FormatGraph([
      fake('a', ['x'], ['y'], { retention: 0.8 }),
      fake('b', ['x'], ['z'], { retention: 1.0 }),
      fake('c', ['z'], ['y'], { retention: 1.0 }),
    ]);
    const route = g.routesFrom('x').get('y');
    expect(route?.steps.map((s) => s.converterId)).toEqual(['a']);
  });

  it('prefers the lossless route when hop count is equal', () => {
    const g = new FormatGraph([
      fake('toLossyMid', ['x'], ['lossy-mid'], { retention: 0.5 }),
      fake('fromLossyMid', ['lossy-mid'], ['z'], { retention: 1.0 }),
      fake('toCleanMid', ['x'], ['clean-mid'], { retention: 1.0 }),
      fake('fromCleanMid', ['clean-mid'], ['z'], { retention: 1.0 }),
    ]);
    const route = g.routesFrom('x').get('z');
    expect(route?.lossless).toBe(true);
    expect(route?.steps.map((s) => s.converterId)).toEqual([
      'toCleanMid',
      'fromCleanMid',
    ]);
  });

  it('respects maxHops and clamps requests above the hard ceiling', () => {
    const g = new FormatGraph([
      fake('c1', ['n0'], ['n1']),
      fake('c2', ['n1'], ['n2']),
      fake('c3', ['n2'], ['n3']),
      fake('c4', ['n3'], ['n4']),
    ]);

    const at3 = g.routesFrom('n0', { maxHops: 3 });
    expect(at3.has('n3')).toBe(true);
    expect(at3.has('n4')).toBe(false);

    const at4 = g.routesFrom('n0', { maxHops: 4 });
    expect(at4.has('n4')).toBe(true);

    const clamped = g.routesFrom('n0', { maxHops: 999 });
    expect(HARD_MAX_HOPS).toBe(4);
    expect(clamped.has('n4')).toBe(true);
  });

  it('produces no edges for converters that were never passed in (unavailable)', () => {
    // The contract: FormatGraph is built from *available* converters only.
    // Simulating "b" being unavailable is just never including it.
    const g = new FormatGraph([fake('a', ['x'], ['y'])]);
    expect(g.routesFrom('x').has('z')).toBe(false);
    expect(g.routesFrom('x').has('y')).toBe(true);
  });

  it('never returns a route that revisits a format', () => {
    const g = new FormatGraph([
      fake('c1', ['a'], ['b']),
      fake('c2', ['b'], ['c']),
      fake('c3', ['c'], ['a']), // cycle back toward the source
      fake('c4', ['c'], ['d']),
    ]);
    const routes = g.routesFrom('a');
    expect(routes.size).toBeGreaterThan(0);
    for (const route of routes.values()) {
      const visited = new Set([route.from]);
      for (const step of route.steps) {
        expect(visited.has(step.to)).toBe(false);
        visited.add(step.to);
      }
    }
  });

  it('breaks equal-weight ties by converter id, keeping the runner-up as fallback', () => {
    const g = new FormatGraph([
      fake('zzz', ['x'], ['y'], { retention: 1, effort: 1 }),
      fake('aaa', ['x'], ['y'], { retention: 1, effort: 1 }),
    ]);
    const route = g.routesFrom('x').get('y');
    expect(route?.steps[0]?.converterId).toBe('aaa');
    expect(g.fallbackFor('x', 'y')?.converterId).toBe('zzz');
  });

  it('picks the cheaper of parallel edges and keeps the pricier as fallback', () => {
    const g = new FormatGraph([
      fake('expensive', ['x'], ['y'], { retention: 0.5 }),
      fake('cheap', ['x'], ['y'], { retention: 1 }),
    ]);
    const route = g.routesFrom('x').get('y');
    expect(route?.steps[0]?.converterId).toBe('cheap');
    expect(g.fallbackFor('x', 'y')?.converterId).toBe('expensive');
  });

  it('rejects leaving a category and re-entering it later (no ping-pong)', () => {
    // Real format ids so categoryOf() resolves real, distinct categories:
    // jpeg/png are 'image', docx is 'document'.
    const g = new FormatGraph([
      fake('toDoc', ['jpeg'], ['docx']),
      fake('backToImage', ['docx'], ['png']),
    ]);
    const routes = g.routesFrom('jpeg');
    expect(routes.has('docx')).toBe(true);
    expect(routes.has('png')).toBe(false);
  });

  it('allows staying within the same category across multiple hops', () => {
    const g = new FormatGraph([
      fake('a', ['jpeg'], ['png']),
      fake('b', ['png'], ['webp']),
    ]);
    const routes = g.routesFrom('jpeg');
    expect(routes.has('png')).toBe(true);
    expect(routes.has('webp')).toBe(true);
  });

  it('matches the BFS closure under the hop cap for a small acyclic graph', () => {
    const converters = [
      fake('c1', ['a'], ['b']),
      fake('c2', ['b'], ['c']),
      fake('c3', ['a'], ['d']),
      fake('c4', ['d'], ['c']),
      fake('c5', ['c'], ['e']),
    ];
    const g = new FormatGraph(converters);
    const maxHops = 3;

    const edges = converters.map(
      (c) => [c.inputs[0] as string, c.outputs[0] as string] as const,
    );
    expect(new Set(g.routesFrom('a', { maxHops }).keys())).toEqual(
      bfsClosure(edges, 'a', maxHops),
    );
  });

  it('never routes back to the source format', () => {
    const g = new FormatGraph([fake('a', ['x'], ['y']), fake('b', ['y'], ['x'])]);
    expect(g.routesFrom('x').has('x')).toBe(false);
  });
});

function bfsClosure(
  edges: readonly (readonly [string, string])[],
  src: string,
  maxHops: number,
): Set<string> {
  let frontier = new Set([src]);
  const visited = new Set([src]);
  const reachable = new Set<string>();
  for (let hop = 0; hop < maxHops; hop++) {
    const next = new Set<string>();
    for (const [from, to] of edges) {
      if (frontier.has(from) && !visited.has(to)) next.add(to);
    }
    for (const n of next) {
      visited.add(n);
      reachable.add(n);
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return reachable;
}
