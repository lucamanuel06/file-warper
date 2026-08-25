/**
 * Regression test against the REAL app-wide graph (every registered
 * converter across every workstream), not just this directory's own
 * converters — the whole point of these gap-fill edges is what `txt` and
 * `xhtml` reach once routed through the html hub and everything else that
 * connects to it.
 */

import { ALL_CONVERTERS } from '@converters/index';
import { FormatGraph } from '@core/graph';
import { describe, expect, it } from 'vitest';

describe('graph reachability: document gap-fill edges', () => {
  const graph = new FormatGraph(ALL_CONVERTERS);

  it('txt now reaches pdf, md, html, docx, and epub', () => {
    const routes = graph.routesFrom('txt', { maxHops: 4 });
    const reachable = new Set(routes.keys());
    for (const target of ['pdf', 'md', 'html', 'docx', 'epub']) {
      expect(reachable.has(target)).toBe(true);
    }
  });

  it('xhtml reaches the same document hub targets', () => {
    const routes = graph.routesFrom('xhtml', { maxHops: 4 });
    const reachable = new Set(routes.keys());
    for (const target of ['pdf', 'md', 'html', 'docx', 'epub', 'txt']) {
      expect(reachable.has(target)).toBe(true);
    }
  });

  it('html now reaches rtf', () => {
    const routes = graph.routesFrom('html', { maxHops: 4 });
    expect(routes.has('rtf')).toBe(true);
  });

  it('every csv/tsv/json/html source can reach ods', () => {
    for (const src of ['csv', 'tsv', 'json', 'html']) {
      const routes = graph.routesFrom(src, { maxHops: 4 });
      expect(routes.has('ods')).toBe(true);
    }
  });
});
