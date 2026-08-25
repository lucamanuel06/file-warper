import type { Cue } from './cue';
import { formatSbvTimestamp, parseSbvTimestamp } from './cue';

const SBV_TIMING = /^(\d+:\d{2}:\d{2}[.,]\d{1,3}),(\d+:\d{2}:\d{2}[.,]\d{1,3})/;

/** Parse an SBV (YouTube captions) document into cues. No header, no index lines. */
export function parseSbv(source: string): Cue[] {
  const normalized = source.replace(/\r\n/g, '\n').replace(/﻿/g, '');
  const blocks = normalized
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const cues: Cue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const timingLine = (lines[0] ?? '').trim();
    const m = SBV_TIMING.exec(timingLine);
    if (!m) continue;
    const [, startRaw, endRaw] = m as unknown as [string, string, string];
    const text = lines.slice(1).join('\n').trim();
    cues.push({
      start: parseSbvTimestamp(startRaw),
      end: parseSbvTimestamp(endRaw),
      text,
    });
  }

  return cues;
}

/** Serialize cues to an SBV document. */
export function serializeSbv(cues: readonly Cue[]): string {
  const body = cues
    .map((cue) => {
      const timing = `${formatSbvTimestamp(cue.start)},${formatSbvTimestamp(cue.end)}`;
      return `${timing}\n${cue.text}\n`;
    })
    .join('\n')
    .trimEnd();
  return `${body}\n`;
}
