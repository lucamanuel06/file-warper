import type { Cue } from './cue';
import { formatSrtTimestamp, parseTimestamp } from './cue';

const SRT_TIMING = /^(\d+:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[.,]\d{1,3})/;

/** Parse an SRT document into cues. Tolerant of missing/duplicate index lines. */
export function parseSrt(source: string): Cue[] {
  const normalized = source.replace(/\r\n/g, '\n').replace(/﻿/g, '');
  const blocks = normalized
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const cues: Cue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    let i = 0;
    // Optional numeric index line.
    if (/^\d+$/.test((lines[i] ?? '').trim())) {
      i += 1;
    }
    const timingLine = (lines[i] ?? '').trim();
    const m = SRT_TIMING.exec(timingLine);
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

/** Serialize cues to an SRT document. */
export function serializeSrt(cues: readonly Cue[]): string {
  const body = cues
    .map((cue, index) => {
      const timing = `${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}`;
      return `${index + 1}\n${timing}\n${cue.text}\n`;
    })
    .join('\n')
    .trimEnd();
  return `${body}\n`;
}
