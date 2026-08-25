/**
 * Integrator-level proof, written after merging all five workstreams.
 *
 * Everything here goes through the REAL registry, the REAL router, and the
 * REAL converters, on REAL files, and asserts on magic bytes / parsed content —
 * never on "the file exists". A converter that writes a 0-byte or malformed
 * file must fail this suite.
 *
 * Converters with `residency: 'main'` (Chromium printToPDF) cannot run here;
 * those are covered by the Playwright e2e suite instead.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ALL_CONVERTERS } from '@converters/index';
import { Router } from '@core/graph';
import { ConverterRegistry } from '@core/registry';
import type {
  ConversionInput,
  ConvertContext,
  Converter,
  FormatId,
  Route,
} from '@core/types';
import { createReadStream } from 'node:fs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ffmpegPath = require('ffmpeg-static') as string;
const ffprobePath = require('@ffprobe-installer/ffprobe').path as string;

/** Deep validation: magic bytes only prove the header. */
async function probe(p: string): Promise<{
  format: { format_name: string; duration?: string };
  streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
}> {
  const { stdout } = await run(ffprobePath, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', p,
  ]);
  return JSON.parse(stdout);
}

let dir: string;
let registry: ConverterRegistry;
let router: Router;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'warp-integration-'));
  registry = new ConverterRegistry();
  for (const c of ALL_CONVERTERS) registry.register(c);
  await registry.refreshAvailability();
  router = new Router(registry);
}, 60_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function ctx(): ConvertContext {
  return {
    onProgress: () => {},
    signal: new AbortController().signal,
    scratchDir: dir,
    log: () => {},
  };
}

function inputFor(p: string, format: FormatId, size: number): ConversionInput {
  return {
    path: p,
    format,
    size,
    readBuffer: () => readFile(p),
    createReadStream: () => createReadStream(p),
  };
}

/** Executes every hop of a route, exactly as the scheduler does. */
async function convert(srcPath: string, from: FormatId, to: FormatId): Promise<string> {
  const route: Route | undefined = router.routesFrom(from).get(to);
  if (!route) throw new Error(`no route ${from} -> ${to}`);

  let current = srcPath;
  for (const [i, step] of route.steps.entries()) {
    const converter = registry.getConverter(step.converterId) as Converter;
    expect(converter, `converter ${step.converterId} missing`).toBeTruthy();
    if (converter.residency === 'main') {
      throw new Error(`SKIP_MAIN:${step.converterId}`);
    }
    const dest = path.join(dir, `hop-${from}-${to}-${i}.${step.to.replace(/\./g, '_')}`);
    const size = (await stat(current)).size;
    await converter.convert(
      inputFor(current, step.from, size),
      { path: dest, format: step.to },
      {},
      ctx(),
    );
    const s = await stat(dest);
    expect(s.size, `hop ${i} (${step.from}->${step.to}) wrote an empty file`).toBeGreaterThan(0);
    current = dest;
  }
  return current;
}

async function head(p: string, n = 16): Promise<Buffer> {
  return (await readFile(p)).subarray(0, n);
}

// ── fixtures (real files, not magic stubs) ─────────────────────────────────

async function makePng(): Promise<string> {
  const p = path.join(dir, 'in.png');
  const buf = await sharp(Buffer.alloc(32 * 32 * 3, 128), {
    raw: { width: 32, height: 32, channels: 3 },
  })
    .png()
    .toBuffer();
  await writeFile(p, buf);
  return p;
}

async function makeWav(): Promise<string> {
  const p = path.join(dir, 'in.wav');
  await run(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
    '-ar', '8000', '-ac', '1', p,
  ]);
  return p;
}

async function makeMp4(): Promise<string> {
  const p = path.join(dir, 'in.mp4');
  await run(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=32x32:rate=5:duration=0.6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p,
  ]);
  return p;
}

async function makeText(name: string, body: string): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, body, 'utf8');
  return p;
}

// ── the graph itself ───────────────────────────────────────────────────────

describe('registry + graph', () => {
  it('registers every converter without a contract violation', () => {
    expect(ALL_CONVERTERS.length).toBeGreaterThan(10);
    expect(registry.allConverters().length).toBe(ALL_CONVERTERS.length);
  });

  it('has the engines available on this machine', () => {
    const snap = registry.availabilitySnapshot();
    const mainOnly = new Set(
      ALL_CONVERTERS.filter((c) => c.residency === 'main').map((c) => c.id),
    );
    const unavailable = Object.entries(snap)
      .filter(([id, a]) => !a.available && !mainOnly.has(id))
      .map(([id, a]) => `${id}: ${'reason' in a ? a.reason : ''}`);
    // LibreOffice is legitimately optional. `residency: 'main'` converters need
    // the Electron runtime and are covered by the Playwright suite instead.
    for (const line of unavailable) {
      expect(line, `unexpected unavailable converter -> ${line}`).toMatch(/libre|soffice/i);
    }
  });

  it('reaches a broad set of targets from common inputs', () => {
    for (const [src, min] of [['png', 6], ['mp4', 6], ['json', 4], ['zip', 3]] as const) {
      const targets = router.targetsFor(src);
      expect(targets.length, `${src} reaches only ${targets.length}`).toBeGreaterThanOrEqual(min);
    }
  });

  it('finds the flagship multi-hop route docx -> pdf once Chromium is up', async () => {
    // Outside Electron the html->pdf converter reports unavailable, so the edge
    // is absent by design. Build a graph that assumes every converter is up and
    // assert the route the product promises actually exists.
    const all = new ConverterRegistry();
    for (const c of ALL_CONVERTERS) all.register(c);
    const optimistic = new Router({
      graphVersion: 1,
      availableConverters: () => ALL_CONVERTERS,
    });
    const route = optimistic.routesFrom('docx').get('pdf');
    expect(route, 'docx -> pdf is unreachable even with every converter up').toBeTruthy();
    expect(route!.steps.length).toBeGreaterThanOrEqual(1);
    expect(route!.steps.length).toBeLessThanOrEqual(3);
  });
});

// ── real conversions ───────────────────────────────────────────────────────

describe('image (sharp)', () => {
  it('png -> webp', async () => {
    const out = await convert(await makePng(), 'png', 'webp');
    const h = await head(out);
    expect(h.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(h.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect((await sharp(out).metadata()).format).toBe('webp');
  });

  it('png -> jpeg', async () => {
    const out = await convert(await makePng(), 'png', 'jpeg');
    expect((await head(out, 3)).toString('hex')).toBe('ffd8ff');
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(32);
  });

  it('png -> avif', async () => {
    const out = await convert(await makePng(), 'png', 'avif');
    expect((await sharp(out).metadata()).format).toBe('heif');
  });

  it('png -> ico', async () => {
    const out = await convert(await makePng(), 'png', 'ico');
    expect((await head(out, 4)).toString('hex')).toBe('00000100');
  });
});

describe('audio/video (ffmpeg)', () => {
  it('wav -> mp3', async () => {
    const out = await convert(await makeWav(), 'wav', 'mp3');
    const h = await head(out, 3);
    const isId3 = h.toString('latin1') === 'ID3';
    const isFrame = h[0] === 0xff && (h[1]! & 0xe0) === 0xe0;
    expect(isId3 || isFrame, `not an mp3: ${h.toString('hex')}`).toBe(true);
  }, 30_000);

  it('wav -> flac', async () => {
    const out = await convert(await makeWav(), 'wav', 'flac');
    expect((await head(out, 4)).toString('latin1')).toBe('fLaC');
  }, 30_000);

  it('mp4 -> gif', async () => {
    const out = await convert(await makeMp4(), 'mp4', 'gif');
    expect((await head(out, 6)).toString('latin1')).toMatch(/^GIF8[79]a$/);
    const info = await probe(out);
    expect(info.streams[0]?.codec_name).toBe('gif');
    expect(info.streams[0]?.width).toBeGreaterThan(0);
  }, 60_000);

  it('mp4 -> mp3 (extract audio, no video stream survives)', async () => {
    const out = await convert(await makeMp4(), 'mp4', 'mp3');
    const info = await probe(out);
    expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(true);
    expect(info.streams.some((s) => s.codec_type === 'video')).toBe(false);
    expect(Number(info.format.duration)).toBeGreaterThan(0.1);
  }, 60_000);

  it('mp4 -> webm', async () => {
    const out = await convert(await makeMp4(), 'mp4', 'webm');
    expect((await head(out, 4)).toString('hex')).toBe('1a45dfa3');
    const info = await probe(out);
    expect(info.format.format_name).toContain('webm');
    const video = info.streams.find((s) => s.codec_type === 'video');
    expect(video?.codec_name, 'webm must carry a VP8/VP9/AV1 stream').toMatch(/vp8|vp9|av1/);
  }, 180_000);
});

describe('data (pure JS)', () => {
  it('json -> yaml and back, losslessly', async () => {
    const original = { name: 'warp', nested: { list: [1, 2, 3], ok: true } };
    const src = await makeText('in.json', JSON.stringify(original));
    const yamlOut = await convert(src, 'json', 'yaml');
    const text = await readFile(yamlOut, 'utf8');
    expect(text).toMatch(/name:\s*warp/);

    const backSrc = path.join(dir, 'round.yaml');
    await writeFile(backSrc, text);
    const jsonOut = await convert(backSrc, 'yaml', 'json');
    expect(JSON.parse(await readFile(jsonOut, 'utf8'))).toEqual(original);
  });

  it('csv -> json', async () => {
    const src = await makeText('in.csv', 'a,b\n1,2\n3,4\n');
    const out = await convert(src, 'csv', 'json');
    const parsed = JSON.parse(await readFile(out, 'utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it('json -> toml', async () => {
    const src = await makeText('t.json', JSON.stringify({ title: 'x', n: 1 }));
    const out = await convert(src, 'json', 'toml');
    expect(await readFile(out, 'utf8')).toMatch(/title\s*=/);
  });
});

describe('archive', () => {
  it('zip -> tar', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const zipped = zipSync({ 'a.txt': strToU8('hello warp') });
    const src = path.join(dir, 'in.zip');
    await writeFile(src, Buffer.from(zipped));
    const out = await convert(src, 'zip', 'tar');
    // ustar magic lives at offset 257
    expect((await readFile(out)).subarray(257, 262).toString('latin1')).toBe('ustar');
  });
});

describe('subtitle', () => {
  it('srt -> vtt', async () => {
    const src = await makeText(
      'in.srt',
      '1\n00:00:01,000 --> 00:00:02,000\nHello warp\n\n',
    );
    const out = await convert(src, 'srt', 'vtt');
    const text = await readFile(out, 'utf8');
    expect(text.startsWith('WEBVTT')).toBe(true);
    expect(text).toContain('Hello warp');
    expect(text).toMatch(/00:00:01\.000/);
  });
});

describe('document (non-Chromium paths)', () => {
  it('md -> html', async () => {
    const src = await makeText('in.md', '# Title\n\nSome **bold** text.\n');
    const out = await convert(src, 'md', 'html');
    const text = await readFile(out, 'utf8');
    expect(text).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(text).toContain('<strong>bold</strong>');
  });

  it('html -> md', async () => {
    const src = await makeText('in.html', '<h1>Title</h1><p>Some <em>text</em>.</p>');
    const out = await convert(src, 'html', 'md');
    const text = await readFile(out, 'utf8');
    expect(text).toMatch(/^#\s+Title/m);
  });

  it('html -> txt', async () => {
    const src = await makeText('t.html', '<h1>Hello</h1><p>World</p>');
    const out = await convert(src, 'html', 'txt');
    const text = await readFile(out, 'utf8');
    expect(text).toContain('Hello');
    expect(text).not.toContain('<h1>');
  });
});
