/**
 * Output-path resolution and collision handling now live in `@core/naming`
 * (`resolveOutputPath`) — see `scheduler.ts`. `sanitizeBasename` is the one
 * piece that's genuinely not in core: it sanitizes an arbitrary *untrusted*
 * string (a dropped file's `name`, not a filesystem path) for the
 * `temp:spill` fallback in `src/main/ipc.ts`, where the concern is avoiding
 * path-traversal/invalid characters in a name the renderer handed us, not
 * output-collision policy.
 */

const FORBIDDEN_CHARS = /[<>:"/\\|?*]/g;
const TRAILING_DOTS_SPACES = /[. ]+$/;
const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

const ASCII_CONTROL_CEILING = 32;
const MAX_FILENAME_BYTES = 255;

/** Drops ASCII control chars without embedding one as a literal in source. */
function stripControlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? ASCII_CONTROL_CEILING;
    if (code >= ASCII_CONTROL_CEILING) out += ch;
  }
  return out;
}

/** Strips forbidden/control chars and trailing dots, rejects reserved device names, clamps to 255 bytes. */
export function sanitizeBasename(name: string): string {
  let out = stripControlChars(name)
    .replace(FORBIDDEN_CHARS, '_')
    .replace(TRAILING_DOTS_SPACES, '');
  if (out.length === 0) out = 'file';
  if (RESERVED_DEVICE_NAMES.has(out.toUpperCase())) out = `_${out}`;

  if (Buffer.byteLength(out, 'utf8') > MAX_FILENAME_BYTES) {
    // Build up whole Unicode code points (not raw bytes) so a multi-byte
    // sequence is never split mid-character.
    let clamped = '';
    let bytes = 0;
    for (const codePoint of out) {
      const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
      if (bytes + codePointBytes > MAX_FILENAME_BYTES) break;
      clamped += codePoint;
      bytes += codePointBytes;
    }
    out = clamped;
  }
  return out;
}
