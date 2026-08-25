/**
 * Property test: random graphs of <=12 nodes / <=25 edges. Dijkstra's cost
 * for every reachable target must equal the cost of the cheapest simple
 * path <= maxHops found by brute-force enumeration. Catches layered-state
 * bugs hand-written cases never will.
 */

import { FormatGraph, weight } from '@core/graph';
import type { EdgeCost } from '@core/types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fake } from '../support/fake-converter';

const MAX_NODES = 12;
const MAX_EDGES = 25;

interface RandEdge {
  readonly from: number;
  readonly to: number;
  readonly cost: EdgeCost;
}

const costArb: fc.Arbitrary<EdgeCost> = fc.record({
  retention: fc.double({ min: 0.01, max: 1, noNaN: true }),
  effort: fc.double({ min: 0, max: 5, noNaN: true }),
  structure: fc.option(fc.double({ min: 0.01, max: 1, noNaN: true }), { nil: undefined }),
});

const graphArb = fc
  .integer({ min: 2, max: MAX_NODES })
  .chain((nodeCount) =>
    fc.record({
      nodeCount: fc.constant(nodeCount),
      edges: fc.array(
        fc.record({
          from: fc.integer({ min: 0, max: nodeCount - 1 }),
          to: fc.integer({ min: 0, max: nodeCount - 1 }),
          cost: costArb,
        }),
        { maxLength: MAX_EDGES },
      ),
      srcIdx: fc.integer({ min: 0, max: nodeCount - 1 }),
      maxHops: fc.integer({ min: 1, max: 4 }),
    }),
  )
  .map(({ nodeCount, edges, srcIdx, maxHops }) => ({
    nodeCount,
    edges: edges.filter((e) => e.from !== e.to) as RandEdge[],
    srcIdx,
    maxHops,
  }));

/** Dedup to the cheapest edge per ordered pair — mirrors FormatGraph's own construction. */
function dedupEdges(
  edges: readonly RandEdge[],
): Map<number, { to: number; weight: number }[]> {
  const byPair = new Map<string, { from: number; to: number; w: number; idx: number }>();
  edges.forEach((e, idx) => {
    const w = weight(e.cost);
    const key = `${e.from}>${e.to}`;
    const existing = byPair.get(key);
    if (!existing || w < existing.w || (w === existing.w && idx < existing.idx)) {
      byPair.set(key, { from: e.from, to: e.to, w, idx });
    }
  });
  const adj = new Map<number, { to: number; weight: number }[]>();
  for (const { from, to, w } of byPair.values()) {
    const list = adj.get(from) ?? [];
    list.push({ to, weight: w });
    adj.set(from, list);
  }
  return adj;
}

/** Brute-force: cheapest simple path <= maxHops to every reachable node. */
function bruteForceBest(
  adj: Map<number, { to: number; weight: number }[]>,
  src: number,
  maxHops: number,
): Map<number, number> {
  const best = new Map<number, number>();

  function dfs(node: number, hops: number, acc: number, visited: Set<number>): void {
    if (hops === maxHops) return;
    for (const e of adj.get(node) ?? []) {
      if (e.to === src || visited.has(e.to)) continue;
      const nd = acc + e.weight;
      const prev = best.get(e.to);
      if (prev === undefined || nd < prev) best.set(e.to, nd);
      visited.add(e.to);
      dfs(e.to, hops + 1, nd, visited);
      visited.delete(e.to);
    }
  }

  dfs(src, 0, 0, new Set([src]));
  return best;
}

describe('FormatGraph — property: Dijkstra matches brute-force shortest simple paths', () => {
  it('agrees with brute force over random small graphs', () => {
    fc.assert(
      fc.property(graphArb, ({ nodeCount, edges, srcIdx, maxHops }) => {
        // Node ids are synthetic ('n0'..) so every node shares category
        // 'other' — this keeps the brute-force reference free of the
        // category-ping-pong rule, which is covered separately in graph.test.ts.
        const nodeIds = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
        const converters = edges.map((e, i) =>
          fake(
            `c${String(i).padStart(3, '0')}`,
            [nodeIds[e.from] as string],
            [nodeIds[e.to] as string],
            e.cost,
          ),
        );

        const graph = new FormatGraph(converters);
        const src = nodeIds[srcIdx] as string;
        const actual = graph.routesFrom(src, { maxHops });

        const adj = dedupEdges(edges);
        const expected = bruteForceBest(adj, srcIdx, maxHops);

        const actualTargets = new Set(actual.keys());
        const expectedTargets = new Set(
          [...expected.keys()].map((i) => nodeIds[i] as string),
        );
        expect(actualTargets).toEqual(expectedTargets);

        for (const [idx, w] of expected) {
          const route = actual.get(nodeIds[idx] as string);
          expect(route).toBeDefined();
          expect(route?.totalWeight).toBeCloseTo(w, 6);
        }
      }),
      { numRuns: 200 },
    );
  });
});
