/**
 * Programmatic tiny test fixtures — one hand-written primitive
 * (`pcmWav`, the text formats) plus everything else derived from it via a
 * real encoder (sharp, jimp, sharp-ico, ffmpeg, @cantoo/pdf-lib, docx,
 * exceljs, fflate, tar, node:zlib).
 *
 * Formats with a `magic` signature but no cheap pure-JS encoder (fonts,
 * legacy OLE documents, single-stream compressors, RAW-ish containers) get
 * a `magicStub`: a buffer built directly from the format's own
 * `FormatDef.magic` entry. Detection only inspects header bytes, so this is
 * a legitimate fixture for exercising the detector — it is not a claim that
 * File Warper can *write* these formats.
 *
 * Results are cached under `node_modules/.cache/warp-fixtures/`, keyed by a
 * hash of the generator's own source so an edit here invalidates the cache.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PDFDocument } from '@cantoo/pdf-lib';
import { extensionFor, getFormat } from '@core/formats';
import type { FormatId } from '@core/types';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { Workbook } from 'exceljs';
import { execa } from 'execa';
import { strToU8, zipSync } from 'fflate';
import ffmpegPath from 'ffmpeg-static';
import { Jimp, JimpMime } from 'jimp';
import sharp, { type Sharp } from 'sharp';
import * as sharpIco from 'sharp-ico';
import * as tar from 'tar';

const CACHE_DIR = join(process.cwd(), 'node_modules', '.cache', 'warp-fixtures');

type Generator = () => Promise<Buffer>;

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

// ---------------------------------------------------------------------------
// Hand-written primitives
// ---------------------------------------------------------------------------

/** 44-byte RIFF/WAVE header + a sine wave, zero dependencies. */
function pcmWav(freqHz: number, seconds: number, sampleRate = 8000): Buffer {
  const n = Math.floor(sampleRate * seconds);
  const dataSize = n * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.5 * 32767,
    );
    out.writeInt16LE(sample, 44 + i * 2);
  }
  return out;
}

/** Builds a buffer that satisfies a format's OWN declared magic signature. */
function magicStub(formatId: FormatId, minSize = 64): Buffer {
  const sig = getFormat(formatId)?.magic?.[0];
  if (!sig) throw new Error(`magicStub: "${formatId}" has no magic signature`);
  const sigBytes = Buffer.from(sig.bytes, 'hex');
  const size = Math.max(minSize, sig.offset + sigBytes.length);
  const out = Buffer.alloc(size, 0);
  sigBytes.copy(out, sig.offset);
  return out;
}

// ---------------------------------------------------------------------------
// sharp / jimp / sharp-ico — raster images
// ---------------------------------------------------------------------------

const RAW_2X2 = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);

function rasterSharp(encode: (img: Sharp) => Sharp): Generator {
  return async () => {
    const img = sharp(RAW_2X2, { raw: { width: 2, height: 2, channels: 3 } });
    return encode(img).toBuffer();
  };
}

const bmp: Generator = async () => {
  const img = new Jimp({ width: 2, height: 2, color: 0xff0000ff });
  return img.getBuffer(JimpMime.bmp);
};

const ico: Generator = async () => {
  const png = await sharp(RAW_2X2, { raw: { width: 2, height: 2, channels: 3 } })
    .png()
    .toBuffer();
  return Buffer.from(sharpIco.encode([png]));
};

// ---------------------------------------------------------------------------
// ffmpeg — audio / video
// ---------------------------------------------------------------------------

async function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'warp-fixture-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function ffmpegTranscode(
  input: Buffer,
  inExt: string,
  outExt: string,
  args: string[] = [],
): Promise<Buffer> {
  return withScratchDir(async (dir) => {
    const inPath = join(dir, `in.${inExt}`);
    const outPath = join(dir, `out.${outExt}`);
    writeFileSync(inPath, input);
    await execa(ffmpegPath as unknown as string, ['-y', '-i', inPath, ...args, outPath]);
    return readFileSync(outPath);
  });
}

async function ffmpegLavfi(
  filter: string,
  outExt: string,
  args: string[] = [],
): Promise<Buffer> {
  return withScratchDir(async (dir) => {
    const outPath = join(dir, `out.${outExt}`);
    await execa(ffmpegPath as unknown as string, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      filter,
      ...args,
      outPath,
    ]);
    return readFileSync(outPath);
  });
}

const wav: Generator = async () => pcmWav(440, 0.05);

// ---------------------------------------------------------------------------
// archives — fflate / tar / node:zlib
// ---------------------------------------------------------------------------

function zipOf(files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync(files, { level: 0 }));
}

/** Zip-family disambiguation reads `mimetype` — see detect.ts. */
function odfZip(mime: string): Buffer {
  return zipOf({
    mimetype: strToU8(mime),
    'META-INF/manifest.xml': strToU8('<?xml version="1.0"?><manifest:manifest/>'),
  });
}

/** OOXML disambiguation reads `[Content_Types].xml` — see detect.ts. */
function ooxmlZip(marker: string): Buffer {
  return zipOf({
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.${marker}"/></Types>`,
    ),
  });
}

const tarBuffer: Generator = () =>
  withScratchDir(async (dir) => {
    writeFileSync(join(dir, 'a.txt'), 'hi');
    const outPath = join(dir, 'out.tar');
    await tar.c({ file: outPath, cwd: dir, sync: true }, ['a.txt']);
    return readFileSync(outPath);
  });

// ---------------------------------------------------------------------------
// Generator map
// ---------------------------------------------------------------------------

const generators: Partial<Record<FormatId, Generator>> = {
  // Image — raster
  jpeg: rasterSharp((img) => img.jpeg()),
  png: rasterSharp((img) => img.png()),
  webp: rasterSharp((img) => img.webp()),
  avif: rasterSharp((img) => img.avif()),
  gif: rasterSharp((img) => img.gif()),
  tiff: rasterSharp((img) => img.tiff()),
  bmp,
  ico,
  psd: async () => magicStub('psd'),

  // Image — vector
  svg: async () =>
    buf(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>\n',
    ),
  svgz: async () =>
    gzipSync(buf('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>\n')),

  // Audio
  wav,
  mp3: async () => ffmpegTranscode(await wav(), 'wav', 'mp3'),
  flac: async () => ffmpegTranscode(await wav(), 'wav', 'flac'),
  aac: async () =>
    ffmpegTranscode(await wav(), 'wav', 'aac', ['-c:a', 'aac', '-b:a', '32k']),
  m4a: async () =>
    ffmpegTranscode(await wav(), 'wav', 'm4a', ['-c:a', 'aac', '-b:a', '32k']),
  ogg: async () => ffmpegTranscode(await wav(), 'wav', 'ogg'),
  opus: async () => ffmpegTranscode(await wav(), 'wav', 'opus', ['-c:a', 'libopus']),
  spx: async () => magicStub('spx'),
  aiff: async () => magicStub('aiff'),
  wma: async () => magicStub('wma'),
  amr: async () => magicStub('amr'),
  ac3: async () => magicStub('ac3'),
  caf: async () => magicStub('caf'),
  au: async () => magicStub('au'),
  mka: async () => magicStub('mka'),

  // Video
  mp4: async () =>
    ffmpegLavfi('testsrc=size=16x16:rate=3:duration=0.1', 'mp4', ['-pix_fmt', 'yuv420p']),
  mov: async () => magicStub('mov'),
  mkv: async () =>
    ffmpegLavfi('testsrc=size=16x16:rate=3:duration=0.1', 'mkv', ['-pix_fmt', 'yuv420p']),
  webm: async () =>
    ffmpegLavfi('testsrc=size=16x16:rate=3:duration=0.1', 'webm', [
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libvpx',
    ]),
  avi: async () => magicStub('avi'),
  m4v: async () => magicStub('m4v'),
  '3gp': async () => magicStub('3gp'),
  flv: async () => magicStub('flv'),
  wmv: async () => magicStub('wmv'),
  mpeg: async () => magicStub('mpeg'),
  ts: async () => magicStub('ts'),
  ogv: async () => magicStub('ogv'),
  y4m: async () => magicStub('y4m'),

  // Document
  pdf: async () => {
    const doc = await PDFDocument.create();
    doc.addPage([72, 72]);
    return Buffer.from(await doc.save());
  },
  docx: async () => {
    const doc = new Document({
      sections: [
        { children: [new Paragraph({ children: [new TextRun('hello warp')] })] },
      ],
    });
    return Packer.toBuffer(doc);
  },
  doc: async () => magicStub('doc'),
  odt: async () => odfZip('application/vnd.oasis.opendocument.text'),
  rtf: async () => buf('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0 hello warp}'),
  txt: async () => buf('hello warp\n'),
  md: async () => buf('# hello\n\nThis is **warp**.\n'),
  html: async () =>
    buf(
      '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>\n',
    ),
  xhtml: async () =>
    buf(
      '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>hi</p></body></html>\n',
    ),
  epub: async () => odfZip('application/epub+zip'),

  // Spreadsheet
  xlsx: async () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['a', 'b']);
    ws.addRow([1, 2]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  },
  xls: async () => magicStub('xls'),
  ods: async () => odfZip('application/vnd.oasis.opendocument.spreadsheet'),
  csv: async () => buf('a,b\n1,2\n3,4\n'),
  tsv: async () => buf('a\tb\n1\t2\n3\t4\n'),

  // Presentation
  pptx: async () => ooxmlZip('presentationml.presentation.main'),
  ppt: async () => magicStub('ppt'),
  odp: async () => odfZip('application/vnd.oasis.opendocument.presentation'),

  // Data
  json: async () => buf('{"a":1,"b":[1,2,3]}\n'),
  jsonl: async () => buf('{"a":1}\n{"a":2}\n{"a":3}\n'),
  json5: async () => buf("{a:1,b:'two',}\n"),
  yaml: async () => buf('a: 1\nb:\n  - 1\n  - 2\n'),
  toml: async () => buf('title = "warp"\n\n[owner]\nname = "warp"\n'),
  xml: async () =>
    buf('<?xml version="1.0" encoding="UTF-8"?>\n<root><item>1</item></root>\n'),
  ini: async () => buf('[section]\nkey=value\n'),
  properties: async () => buf('key=value\nother.key=1\n'),
  plist: async () =>
    buf(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>a</key><integer>1</integer></dict></plist>\n',
    ),

  // Archive
  zip: async () => zipOf({ 'a.txt': strToU8('hi') }),
  tar: tarBuffer,
  'tar.gz': async () => gzipSync(await tarBuffer()),
  'tar.bz2': async () => magicStub('tar.bz2'),
  'tar.xz': async () => magicStub('tar.xz'),
  gz: async () => gzipSync(buf('hello warp\n')),
  bz2: async () => magicStub('bz2'),
  xz: async () => magicStub('xz'),
  '7z': async () => magicStub('7z'),
  rar: async () => magicStub('rar'),
  cab: async () => magicStub('cab'),
  iso: async () => magicStub('iso', 32 * 1024 + 16),

  // Font
  ttf: async () => magicStub('ttf'),
  otf: async () => magicStub('otf'),
  woff: async () => magicStub('woff'),
  woff2: async () => magicStub('woff2'),
  eot: async () => magicStub('eot'),

  // Subtitle
  srt: async () => buf('1\n00:00:00,000 --> 00:00:01,000\nhello warp\n'),
  vtt: async () => buf('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello warp\n'),
  ass: async () =>
    buf(
      '[Script Info]\nTitle: warp\n\n[Events]\nFormat: Layer, Start, End, Text\nDialogue: 0,0:00:00.00,0:00:01.00,,,0,0,0,,hello warp\n',
    ),
  ttml: async () =>
    buf(
      '<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p>hello warp</p></div></body></tt>\n',
    ),
  sbv: async () => buf('0:00:00.000,0:00:01.000\nhello warp\n'),
};

/** Every `FormatId` this module can produce a fixture for. */
export const GENERATED_FORMATS: readonly FormatId[] = Object.keys(generators);

/** Generates (or reuses the cached) fixture and returns its absolute path. */
export async function getFixturePath(formatId: FormatId): Promise<string> {
  const gen = generators[formatId];
  if (!gen) throw new Error(`generators: no fixture generator for "${formatId}"`);

  const hash = createHash('sha1').update(gen.toString()).digest('hex').slice(0, 12);
  const ext = extensionFor(formatId);
  const dest = join(CACHE_DIR, `${formatId}-${hash}.${ext}`);

  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    const data = await gen();
    writeFileSync(dest, data);
  }
  return dest;
}
