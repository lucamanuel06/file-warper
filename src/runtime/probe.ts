/**
 * TEMPORARY STUB — replace with `@core/detect` once W1 lands. Detection order
 * (magic -> extension) matches docs/spec-core-architecture.md §3, driven by
 * the same frozen `FormatDef.magic` table so this doubles as the test oracle
 * once real tests exist.
 */

import fsp from 'node:fs/promises';
import { FORMATS, formatFromFilename, getFormat } from '@core/formats';
import type { FormatId, MagicSig, ProbeResult } from '@core/types';

const MAGIC_READ_BYTES = 64;

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2)
    out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function matchesMagic(buf: Buffer, sig: MagicSig): boolean {
  const bytes = hexToBytes(sig.bytes);
  const mask = sig.mask ? hexToBytes(sig.mask) : bytes.map(() => 0xff);
  if (buf.length < sig.offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    const wantByte = bytes[i];
    const maskByte = mask[i];
    if (wantByte === undefined || maskByte === undefined) return false;
    const actual = (buf[sig.offset + i] ?? 0) & maskByte;
    if (actual !== (wantByte & maskByte)) return false;
  }
  return true;
}

export interface DetectResult {
  readonly format: FormatId | null;
  readonly confidence: ProbeResult['confidence'];
  readonly warnings: string[];
}

export function detectFormat(buf: Buffer, filename: string): DetectResult {
  const magicMatch = FORMATS.find((fmt) =>
    fmt.magic?.some((sig) => matchesMagic(buf, sig)),
  );
  const extMatch = formatFromFilename(filename);

  if (magicMatch) {
    const warnings: string[] = [];
    if (extMatch && extMatch !== magicMatch.id) {
      const extLabel = getFormat(extMatch)?.label ?? extMatch;
      warnings.push(
        `This file's extension suggests ${extLabel}, but it looks like ${magicMatch.label}.`,
      );
    }
    return { format: magicMatch.id, confidence: 'magic', warnings };
  }
  if (extMatch) return { format: extMatch, confidence: 'extension', warnings: [] };
  return { format: null, confidence: 'none', warnings: [] };
}

export async function probeFile(filePath: string): Promise<ProbeResult> {
  const name = filePath.split(/[/\\]/).pop() ?? filePath;
  const stat = await fsp.stat(filePath);
  const handle = await fsp.open(filePath, 'r');
  let detection: DetectResult;
  try {
    const buf = Buffer.alloc(MAGIC_READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAGIC_READ_BYTES, 0);
    detection = detectFormat(buf.subarray(0, bytesRead), name);
  } finally {
    await handle.close();
  }

  const category = detection.format
    ? (getFormat(detection.format)?.category ?? null)
    : null;
  return {
    path: filePath,
    name,
    size: stat.size,
    format: detection.format,
    category,
    confidence: detection.confidence,
    warnings: detection.warnings,
  };
}
