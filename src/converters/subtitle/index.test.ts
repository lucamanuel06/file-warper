import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { subtitleConverters } from './index';
import { parseSrt } from './srt';
import { parseVtt } from './vtt';

const converter = subtitleConverters[0];
if (!converter) throw new Error('subtitleConverters is empty');

function makeInput(path: string, format: string, content: string): ConversionInput {
  const buf = Buffer.from(content, 'utf8');
  return {
    path,
    format,
    size: buf.byteLength,
    async readBuffer() {
      return buf;
    },
    createReadStream() {
      throw new Error('not used in these tests');
    },
  };
}

function makeContext(scratchDir: string): ConvertContext {
  return {
    onProgress() {},
    signal: new AbortController().signal,
    scratchDir,
    log() {},
  };
}

const SRT_FIXTURE = `1
00:00:01,000 --> 00:00:04,000
Hello there.

2
00:00:05,200 --> 00:00:07,800
Multi-line
subtitle text.
`;

describe('subtitle converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'subtitle-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('declares all five subtitle formats as inputs and outputs', () => {
    expect(converter.inputs).toEqual(['srt', 'vtt', 'ass', 'ttml', 'sbv']);
    expect(converter.outputs).toEqual(['srt', 'vtt', 'ass', 'ttml', 'sbv']);
  });

  it('supports every distinct pair and rejects identity pairs', () => {
    expect(converter.supports?.('srt', 'vtt')).toBe(true);
    expect(converter.supports?.('ass', 'ttml')).toBe(true);
    expect(converter.supports?.('srt', 'srt')).toBe(false);
  });

  it('reports full retention among srt/vtt/sbv/ttml pairs', () => {
    expect(converter.cost('srt', 'vtt').retention).toBe(1);
    expect(converter.cost('vtt', 'sbv').retention).toBe(1);
    expect(converter.cost('sbv', 'ttml').retention).toBe(1);
  });

  it('reports lossless retention converting INTO ass', () => {
    expect(converter.cost('srt', 'ass').retention).toBe(1);
  });

  it('reports reduced retention converting OUT OF ass', () => {
    expect(converter.cost('ass', 'srt').retention).toBeLessThan(1);
  });

  it('never throws from availability() and reports available', async () => {
    await expect(converter.availability()).resolves.toEqual({ available: true });
  });

  it('converts SRT to VTT and writes a real file', async () => {
    const input = makeInput(join(dir, 'in.srt'), 'srt', SRT_FIXTURE);
    const outPath = join(dir, 'out.vtt');
    const result = await converter.convert(
      input,
      { path: outPath, format: 'vtt' },
      {},
      makeContext(dir),
    );
    const written = await readFile(outPath, 'utf8');
    expect(written.startsWith('WEBVTT')).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(result.meta).toEqual({ cueCount: 2 });
  });

  it('round-trips srt -> vtt -> srt with a deep-equal cue list (Layer 4)', async () => {
    const originalCues = parseSrt(SRT_FIXTURE);

    const vttPath = join(dir, 'roundtrip.vtt');
    await converter.convert(
      makeInput(join(dir, 'in.srt'), 'srt', SRT_FIXTURE),
      { path: vttPath, format: 'vtt' },
      {},
      makeContext(dir),
    );
    const vttContent = await readFile(vttPath, 'utf8');
    expect(parseVtt(vttContent)).toEqual(originalCues);

    const srtPath = join(dir, 'roundtrip.srt');
    await converter.convert(
      makeInput(vttPath, 'vtt', vttContent),
      { path: srtPath, format: 'srt' },
      {},
      makeContext(dir),
    );
    const srtContent = await readFile(srtPath, 'utf8');
    expect(parseSrt(srtContent)).toEqual(originalCues);
  });

  it('warns and lowers fidelity when leaving ass, but not when entering it', async () => {
    const assFixture = [
      '[Script Info]',
      '[V4+ Styles]',
      'Format: Name',
      'Style: Default',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Styled {\\i1}text{\\i0}',
      '',
    ].join('\n');

    const outPath = join(dir, 'from-ass.srt');
    const result = await converter.convert(
      makeInput(join(dir, 'in.ass'), 'ass', assFixture),
      { path: outPath, format: 'srt' },
      {},
      makeContext(dir),
    );
    expect(result.warnings).toContain('Dropped subtitle styling.');

    const srtContent = await readFile(outPath, 'utf8');
    expect(srtContent).toContain('Styled text');
    expect(srtContent).not.toContain('{\\i1}');

    const intoAssPath = join(dir, 'into-ass.ass');
    const intoResult = await converter.convert(
      makeInput(join(dir, 'in.srt'), 'srt', SRT_FIXTURE),
      { path: intoAssPath, format: 'ass' },
      {},
      makeContext(dir),
    );
    expect(intoResult.warnings).toBeUndefined();
    const assContent = await readFile(intoAssPath, 'utf8');
    expect(assContent).toContain('[Events]');
  });

  it('throws E_CORRUPT_INPUT for a file with no recognizable cues', async () => {
    const input = makeInput(join(dir, 'empty.srt'), 'srt', 'not a subtitle file at all');
    await expect(
      converter.convert(
        input,
        { path: join(dir, 'out.vtt'), format: 'vtt' },
        {},
        makeContext(dir),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });
});
