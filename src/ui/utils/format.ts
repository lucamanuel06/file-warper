import type { FormatDef } from '@core/types';

/**
 * `text-overflow: ellipsis` truncates from the end, which eats the extension —
 * the most informative part of a filename. This keeps a head and tail slice.
 */
export function middleTruncate(name: string, max = 42): string {
  if (name.length <= max) return name;
  const keep = max - 1; // room for the ellipsis character
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

const CATEGORY_SUFFIXES =
  / (Image|Audio|Video|Document|Workbook|Archive|Font|Subtitle|Ebook|Spreadsheet|Presentation)$/;

/** "WebP Image" -> "WebP" — the picker and chips show brand-short names. */
export function shortFormatLabel(def: FormatDef): string {
  return def.label.replace(CATEGORY_SUFFIXES, '');
}
