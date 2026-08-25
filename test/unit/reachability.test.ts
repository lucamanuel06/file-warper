/**
 * Committed reachability snapshot — the highest-signal test in the suite
 * per docs/spec-core-architecture.md §6. Uses a small FIXED synthetic
 * converter set (never the real, still-growing registry) so a change here
 * always means a real graph-shape change, reviewable as a diff.
 */

import { FormatGraph } from '@core/graph';
import type { Converter, FormatId } from '@core/types';
import { describe, expect, it } from 'vitest';
import { fake } from '../support/fake-converter';

const CONVERTERS: readonly Converter[] = [
  fake('img:toRaster', ['jpeg', 'bmp'], ['png', 'webp'], { retention: 1 }),
  fake('img:toJpeg', ['png', 'webp'], ['jpeg'], { retention: 0.9 }),
  fake('doc:docxToHtml', ['docx'], ['html'], { retention: 0.95, structure: 0.9 }),
  fake('doc:mdToHtml', ['md'], ['html'], { retention: 1 }),
  fake(
    'doc:htmlToPdf',
    ['html'],
    ['pdf'],
    { retention: 1, structure: 1 },
    { residency: 'main' },
  ),
  fake('doc:htmlToMd', ['html'], ['md'], { retention: 0.8 }),
  fake('data:jsonToYaml', ['json'], ['yaml'], { retention: 1 }),
  fake('data:yamlToJson', ['yaml'], ['json'], { retention: 1 }),
  fake('archive:zipToTar', ['zip'], ['tar'], { retention: 1 }),
  fake('archive:tarToZip', ['tar'], ['zip'], { retention: 1 }),
];

describe('reachability snapshot — small fixed synthetic converter set', () => {
  it('matches the committed snapshot', () => {
    const graph = new FormatGraph(CONVERTERS);
    const nodes = [
      ...new Set(CONVERTERS.flatMap((c) => [...c.inputs, ...c.outputs])),
    ].sort() as FormatId[];

    const reachability: Record<string, string[]> = {};
    for (const node of nodes) {
      reachability[node] = [...graph.routesFrom(node).keys()].sort();
    }

    expect(reachability).toMatchSnapshot();
  });
});
