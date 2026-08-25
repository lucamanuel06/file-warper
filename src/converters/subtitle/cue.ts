/**
 * Shared cue model for all subtitle formats in this converter.
 *
 * `start`/`end` are milliseconds from the start of the file. `text` is plain
 * text (may contain embedded newlines for multi-line cues). `style` is an
 * optional free-form label (e.g. an ASS style name) — carried through when
 * the target format has something to hang it on, dropped otherwise.
 */
export interface Cue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly style?: string;
}

/** Clamp/normalize a millisecond value to a non-negative integer. */
function ms(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/** `HH:MM:SS,mmm` or `HH:MM:SS.mmm` -> milliseconds. */
export function parseTimestamp(raw: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(raw.trim());
  if (!m) return 0;
  const [, h, min, s, frac] = m as unknown as [string, string, string, string, string];
  const millis = frac.padEnd(3, '0').slice(0, 3);
  return ms(
    Number(h) * 3_600_000 + Number(min) * 60_000 + Number(s) * 1000 + Number(millis),
  );
}

/** `H:MM:SS.mmm` (SBV — hour not zero-padded) -> milliseconds. Reuses the general parser. */
export function parseSbvTimestamp(raw: string): number {
  return parseTimestamp(raw);
}

/** `H:MM:SS.CC` (ASS — centiseconds) -> milliseconds. */
export function parseAssTimestamp(raw: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,2})$/.exec(raw.trim());
  if (!m) return 0;
  const [, h, min, s, frac] = m as unknown as [string, string, string, string, string];
  const centis = Number(frac.padEnd(2, '0').slice(0, 2));
  return ms(
    Number(h) * 3_600_000 + Number(min) * 60_000 + Number(s) * 1000 + centis * 10,
  );
}

function splitParts(totalMs: number): {
  h: number;
  m: number;
  s: number;
  rest: number;
} {
  const t = ms(totalMs);
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const rest = t % 1000;
  return { h, m, s, rest };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** milliseconds -> `HH:MM:SS,mmm` (SRT). */
export function formatSrtTimestamp(totalMs: number): string {
  const { h, m, s, rest } = splitParts(totalMs);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(rest, 3)}`;
}

/** milliseconds -> `HH:MM:SS.mmm` (VTT / TTML). */
export function formatDotTimestamp(totalMs: number): string {
  const { h, m, s, rest } = splitParts(totalMs);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(rest, 3)}`;
}

/** milliseconds -> `H:MM:SS.mmm` (SBV — unpadded hour). */
export function formatSbvTimestamp(totalMs: number): string {
  const { h, m, s, rest } = splitParts(totalMs);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(rest, 3)}`;
}

/** milliseconds -> `H:MM:SS.CC` (ASS — centiseconds, unpadded hour). */
export function formatAssTimestamp(totalMs: number): string {
  const { h, m, s, rest } = splitParts(totalMs);
  const centis = Math.round(rest / 10);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(centis, 2)}`;
}
