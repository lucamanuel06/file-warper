import type { Cue } from './cue';
import { formatDotTimestamp, parseTimestamp } from './cue';

const VTT_TIMING = /^(\d+:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[.,]\d{1,3})/;

/** Parse a WebVTT document into cues. Ignores NOTE/STYLE/REGION blocks. */
export function parseVtt(source: string): Cue[] {
  const normalized = source.replace(/\r\n/g, '\n').replace(/﻿/g, '');
  const blocks = normalized
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const cues: Cue[] = [];

  for (const block of blocks) {
    if (/^WEBVTT/.test(block)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(block)) continue;

    const lines = block.split('\n');
    let i = 0;
    // Optional cue identifier line before the timing line.
    if (i < lines.length && !VTT_TIMING.test((lines[i] ?? '').trim())) {
      i += 1;
    }
    const timingLine = (lines[i] ?? '').trim();
    const m = VTT_TIMING.exec(timingLine);
    if (!m) continue;
    const [, startRaw, endRaw] = m as unknown as [string, string, string];
    const text = lines
      .slice(i + 1)
      .join('\n')
      .trim();
    cues.push({ start: parseTimestamp(startRaw), end: parseTimestamp(endRaw), text });
  }

  return cues;
}

/** Serialize cues to a WebVTT document. */
export function serializeVtt(cues: readonly Cue[]): string {
  const body = cues
    .map((cue) => {
      const timing = `${formatDotTimestamp(cue.start)} --> ${formatDotTimestamp(cue.end)}`;
      return `${timing}\n${cue.text}\n`;
    })
    .join('\n')
    .trimEnd();
  return body.length > 0 ? `WEBVTT\n\n${body}\n` : 'WEBVTT\n';
}
