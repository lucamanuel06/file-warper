/**
 * Small shared helpers for the data-format codecs. No engine-specific code
 * lives here — just plain-value plumbing used by more than one codec.
 */

import { ConversionError } from '@core/types';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flattens a nested plain-object tree into `[dotted.path, leafValue]` pairs. */
export function flattenToPairs(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return prefix ? [[prefix, {}]] : [];
    return entries.flatMap(([key, v]) =>
      flattenToPairs(v, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [[prefix, value]];
}

/** Renders a leaf value (post-flatten) as plain text for INI/properties. */
export function scalarToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

const FORMAT_LABELS: Record<string, string> = {
  json: 'JSON',
  json5: 'JSON5',
  jsonl: 'JSON Lines',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  ini: 'INI',
  properties: 'Java properties',
  plist: 'property list',
  csv: 'CSV',
  tsv: 'TSV',
};

export function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format.toUpperCase();
}

export function corruptInput(format: string, cause: unknown): ConversionError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ConversionError({
    code: 'E_CORRUPT_INPUT',
    userMessage: `This file isn't valid ${formatLabel(format)} — it couldn't be parsed.`,
    detail,
    retryable: false,
  });
}

export function unsupportedFeature(
  userMessage: string,
  detail?: string,
): ConversionError {
  return new ConversionError({
    code: 'E_UNSUPPORTED_FEATURE',
    userMessage,
    detail,
    retryable: false,
  });
}

export function engineFailure(format: string, cause: unknown): ConversionError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ConversionError({
    code: 'E_ENGINE',
    userMessage: `Couldn't write the result as ${formatLabel(format)}.`,
    detail,
    retryable: false,
  });
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ConversionError({
      code: 'E_CANCELLED',
      userMessage: 'The conversion was cancelled.',
      retryable: false,
    });
  }
}
