/**
 * TEMPORARY STUB — replace with `@core/registry` + `@core/graph` once W1 lands.
 *
 * W1 owns `src/core/registry.ts` (ConverterRegistry) and `src/core/graph.ts`
 * (FormatGraph + layered Dijkstra router), per docs/spec-core-architecture.md
 * §1-2. Neither file exists on this branch yet, and the runtime needs
 * *something* concrete to schedule jobs against, so this is a compact,
 * spec-faithful (but not layered-state-exact) stand-in: plain Dijkstra with a
 * hop cap and category-no-reentry, built only from the two frozen inputs that
 * do exist (`@core/types`, `@core/formats`).
 *
 * Shape matches the spec closely enough that swapping the import is a
 * mechanical change: `ConverterRegistry`, `Router.targetsFor`,
 * `Router.targetsForAll`, `Router.routeFor` all mirror the documented API.
 */

import { getFormat } from '@core/formats';
import type {
  Availability,
  Converter,
  ConverterId,
  Edge,
  EdgeCost,
  FormatId,
  Route,
  RouteStep,
  TargetSet,
} from '@core/types';

const HOP_PENALTY = 1000;
const DEFAULT_MAX_HOPS = 3;
const HARD_MAX_HOPS = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function weight(cost: EdgeCost): number {
  const qualityLoss = -Math.log(clamp(cost.retention, 1e-3, 1)) * 300;
  const structLoss = -Math.log(clamp(cost.structure ?? 1, 1e-3, 1)) * 150;
  return HOP_PENALTY + qualityLoss + structLoss + cost.effort;
}

function categoryBit(format: FormatId): number {
  const cat = getFormat(format)?.category ?? 'other';
  const order = [
    'image',
    'audio',
    'video',
    'document',
    'spreadsheet',
    'presentation',
    'data',
    'archive',
    'font',
    'subtitle',
    'other',
  ];
  const idx = order.indexOf(cat);
  return 1 << (idx < 0 ? order.length - 1 : idx);
}

export class ConverterRegistry {
  private readonly byId = new Map<ConverterId, Converter>();
  private readonly availabilityById = new Map<ConverterId, Availability>();
  /** Bumped whenever availability changes -> invalidates the Router's route cache. */
  graphVersion = 0;

  register(converter: Converter): void {
    if (this.byId.has(converter.id)) {
      throw new Error(`duplicate converter id: ${converter.id}`);
    }
    for (const fmt of [...converter.inputs, ...converter.outputs]) {
      if (!getFormat(fmt)) {
        throw new Error(
          `converter "${converter.id}" references unknown FormatId "${fmt}"`,
        );
      }
    }
    this.byId.set(converter.id, converter);
    this.availabilityById.set(converter.id, { available: true });
    this.graphVersion++;
  }

  async refreshAvailability(): Promise<void> {
    let changed = false;
    await Promise.all(
      [...this.byId.values()].map(async (c) => {
        const next = await c.availability();
        const prev = this.availabilityById.get(c.id);
        if (JSON.stringify(prev) !== JSON.stringify(next)) changed = true;
        this.availabilityById.set(c.id, next);
      }),
    );
    if (changed) this.graphVersion++;
  }

  availableConverters(): Converter[] {
    return [...this.byId.values()].filter(
      (c) => this.availabilityById.get(c.id)?.available !== false,
    );
  }

  allConverters(): Converter[] {
    return [...this.byId.values()];
  }

  availabilitySnapshot(): Record<ConverterId, Availability> {
    return Object.fromEntries(this.availabilityById);
  }
}

function keyOf(fmt: FormatId, hops: number, mask: number): string {
  return `${fmt}|${hops}|${mask}`;
}

class MinHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly cmp: (a: T, b: T) => number) {}
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    this.items.push(item);
    this.items.sort(this.cmp);
  }
  pop(): T | undefined {
    return this.items.shift();
  }
}

export class FormatGraph {
  private readonly out = new Map<FormatId, Edge[]>();
  /** Runner-up edge per ordered (from,to) pair — used for retry-on-failure. */
  private readonly runnersUp = new Map<string, Edge>();

  constructor(converters: readonly Converter[]) {
    const best = new Map<string, Edge>();
    for (const c of converters) {
      for (const from of c.inputs) {
        for (const to of c.outputs) {
          if (from === to) continue;
          if (!(c.supports?.(from, to) ?? true)) continue;
          const cost = c.cost(from, to);
          const edge: Edge = { from, to, converterId: c.id, weight: weight(cost), cost };
          const pairKey = `${from}>${to}`;
          const existing = best.get(pairKey);
          if (!existing || edge.weight < existing.weight) {
            if (existing) this.runnersUp.set(pairKey, existing);
            best.set(pairKey, edge);
          } else {
            const runnerUp = this.runnersUp.get(pairKey);
            if (!runnerUp || edge.weight < runnerUp.weight)
              this.runnersUp.set(pairKey, edge);
          }
        }
      }
    }
    for (const edge of best.values()) {
      const list = this.out.get(edge.from) ?? [];
      list.push(edge);
      this.out.set(edge.from, list);
    }
  }

  /** The runner-up converter for a pair, if any — used for one retry on hop failure. */
  fallbackFor(from: FormatId, to: FormatId): Edge | undefined {
    return this.runnersUp.get(`${from}>${to}`);
  }

  routesFrom(src: FormatId, maxHops = DEFAULT_MAX_HOPS): Map<FormatId, Route> {
    const cappedHops = clamp(maxHops, 1, HARD_MAX_HOPS);
    const dist = new Map<string, number>();
    const prev = new Map<string, { key: string; edge: Edge }>();
    const bestPerFormat = new Map<FormatId, { key: string; d: number }>();

    const startMask = categoryBit(src);
    const startKey = keyOf(src, 0, startMask);
    dist.set(startKey, 0);
    const pq = new MinHeap<{
      key: string;
      fmt: FormatId;
      hops: number;
      mask: number;
      d: number;
    }>((a, b) => a.d - b.d);
    pq.push({ key: startKey, fmt: src, hops: 0, mask: startMask, d: 0 });

    while (pq.size > 0) {
      const cur = pq.pop();
      if (!cur) break;
      if (cur.d > (dist.get(cur.key) ?? Number.POSITIVE_INFINITY)) continue;
      if (cur.hops > 0) {
        const existing = bestPerFormat.get(cur.fmt);
        if (!existing || cur.d < existing.d)
          bestPerFormat.set(cur.fmt, { key: cur.key, d: cur.d });
      }
      if (cur.hops === cappedHops) continue;

      const curCatBit = categoryBit(cur.fmt);
      for (const edge of this.out.get(cur.fmt) ?? []) {
        if (edge.to === src) continue;
        const bit = categoryBit(edge.to);
        // Once a category is abandoned it may not be re-entered.
        if (bit !== curCatBit && (cur.mask & bit) !== 0) continue;
        const nextMask = cur.mask | bit;
        const nextKey = keyOf(edge.to, cur.hops + 1, nextMask);
        const nd = cur.d + edge.weight;
        if (nd < (dist.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
          dist.set(nextKey, nd);
          prev.set(nextKey, { key: cur.key, edge });
          pq.push({
            key: nextKey,
            fmt: edge.to,
            hops: cur.hops + 1,
            mask: nextMask,
            d: nd,
          });
        }
      }
    }

    const routes = new Map<FormatId, Route>();
    for (const [fmt, { key, d }] of bestPerFormat) {
      const steps: RouteStep[] = [];
      let cursor: string | undefined = key;
      while (cursor) {
        const link = prev.get(cursor);
        if (!link) break;
        steps.unshift({
          converterId: link.edge.converterId,
          from: link.edge.from,
          to: link.edge.to,
        });
        cursor = link.key;
      }
      if (steps.length === 0) continue;
      const retention = steps.reduce((acc, step) => {
        const edge = (this.out.get(step.from) ?? []).find(
          (e) => e.to === step.to && e.converterId === step.converterId,
        );
        return acc * (edge?.cost.retention ?? 1);
      }, 1);
      routes.set(fmt, {
        from: src,
        to: fmt,
        steps,
        totalWeight: d,
        retention,
        lossless: retention >= 0.999,
      });
    }
    return routes;
  }
}

export class Router {
  private readonly cache = new Map<string, Map<FormatId, Route>>();
  private graph: FormatGraph;
  private version = -1;

  constructor(private readonly registry: ConverterRegistry) {
    this.graph = new FormatGraph(registry.availableConverters());
  }

  private ensureFresh(): void {
    if (this.registry.graphVersion !== this.version) {
      this.graph = new FormatGraph(this.registry.availableConverters());
      this.version = this.registry.graphVersion;
      this.cache.clear();
    }
  }

  private routesFromCached(src: FormatId): Map<FormatId, Route> {
    this.ensureFresh();
    const key = `${src}|${this.version}`;
    let routes = this.cache.get(key);
    if (!routes) {
      routes = this.graph.routesFrom(src);
      this.cache.set(key, routes);
    }
    return routes;
  }

  routeFor(src: FormatId, to: FormatId): Route | undefined {
    return this.routesFromCached(src).get(to);
  }

  fallbackFor(from: FormatId, to: FormatId): Edge | undefined {
    this.ensureFresh();
    return this.graph.fallbackFor(from, to);
  }

  targetsFor(src: FormatId): FormatId[] {
    return [...this.routesFromCached(src).keys()];
  }

  targetsForAll(srcs: readonly FormatId[]): TargetSet {
    if (srcs.length === 0) return { common: [], partial: {} };
    const perSrc = srcs.map((s) => this.routesFromCached(s));
    const counts = new Map<FormatId, FormatId[]>();
    for (let i = 0; i < srcs.length; i++) {
      const src = srcs[i];
      const routes = perSrc[i];
      if (src === undefined || routes === undefined) continue;
      for (const target of routes.keys()) {
        const list = counts.get(target) ?? [];
        list.push(src);
        counts.set(target, list);
      }
    }
    const common: FormatId[] = [];
    const partial: Record<FormatId, FormatId[]> = {};
    const uniqueSrcs = new Set(srcs);
    for (const [target, reachableFrom] of counts) {
      if (reachableFrom.length === uniqueSrcs.size) common.push(target);
      else partial[target] = reachableFrom;
    }
    return { common, partial };
  }
}
