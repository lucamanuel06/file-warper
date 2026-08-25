/**
 * Office-format conversions via a real LibreOffice `soffice` binary, when
 * one is installed. Optional: `availability()` reports `{ available: false
 * }` and contributes zero edges whenever `soffice` can't be found — this
 * file never throws just because LibreOffice isn't on the machine.
 *
 * `execa` is ESM-only (same situation as `file-type` — see CLAUDE.md), so
 * every call goes through a dynamic `await import('execa')`.
 *
 * The `-env:UserInstallation=file:///tmp/fw-<uuid>` flag is not optional:
 * without a unique profile directory per invocation, concurrent `soffice
 * --headless` runs silently hang waiting on each other's lock file.
 */

import { randomUUID } from 'node:crypto';
import { access, copyFile, readdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type {
  ConversionInput,
  ConversionOutput,
  ConvertContext,
  Converter,
  ConverterOptions,
  ConvertResult,
  EdgeCost,
  FormatId,
} from '@core/types';
import { ConversionError } from '@core/types';

interface OfficeEdge {
  readonly from: FormatId;
  readonly to: FormatId;
  /** The `--convert-to` target extension. */
  readonly targetExt: string;
}

// A conservative set of 1-hop Office conversions `soffice --convert-to`
// handles well. `doc`/`ppt` are readOnly in the format registry (see
// src/core/formats.ts) so they only ever appear as `from`.
const OFFICE_EDGES: readonly OfficeEdge[] = [
  { from: 'docx', to: 'odt', targetExt: 'odt' },
  { from: 'odt', to: 'docx', targetExt: 'docx' },
  { from: 'doc', to: 'docx', targetExt: 'docx' },
  { from: 'rtf', to: 'docx', targetExt: 'docx' },
  { from: 'pptx', to: 'odp', targetExt: 'odp' },
  { from: 'odp', to: 'pptx', targetExt: 'pptx' },
];

const OFFICE_INPUTS: readonly FormatId[] = [...new Set(OFFICE_EDGES.map((e) => e.from))];
const OFFICE_OUTPUTS: readonly FormatId[] = [...new Set(OFFICE_EDGES.map((e) => e.to))];

function findEdge(from: FormatId, to: FormatId): OfficeEdge | undefined {
  return OFFICE_EDGES.find((e) => e.from === from && e.to === to);
}

const CANDIDATE_SOFFICE_PATHS: readonly string[] = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  join(homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface SofficeProbe {
  readonly path: string;
  readonly version?: string;
}

/** Probes the three known locations, in order. Never throws. */
async function findSoffice(): Promise<SofficeProbe | undefined> {
  for (const candidate of CANDIDATE_SOFFICE_PATHS) {
    if (await fileExists(candidate)) {
      return { path: candidate };
    }
  }
  try {
    const { execa } = await import('execa');
    const result = await execa('which', ['soffice']);
    const resolved = result.stdout.trim();
    if (resolved.length > 0) {
      return { path: resolved };
    }
  } catch {
    // `which` exits non-zero when nothing is found — not an error for us.
  }
  return undefined;
}

// Cheap, but not free (a `which` spawn in the worst case) — cache the result
// for the lifetime of this module, exactly as the Converter contract asks.
let cachedProbe: Promise<SofficeProbe | undefined> | undefined;

function probeSoffice(): Promise<SofficeProbe | undefined> {
  if (!cachedProbe) {
    cachedProbe = findSoffice();
  }
  return cachedProbe;
}

/** Test-only: forget the cached probe so tests can simulate a fresh process. */
export function resetLibreOfficeProbeCache(): void {
  cachedProbe = undefined;
}

export const libreOfficeConverter: Converter = {
  id: 'doc:libreoffice-office',
  name: 'Office Documents (LibreOffice)',
  engine: 'libreoffice',
  residency: 'worker',

  inputs: OFFICE_INPUTS,
  outputs: OFFICE_OUTPUTS,

  supports(from: FormatId, to: FormatId): boolean {
    return findEdge(from, to) !== undefined;
  },

  cost(): EdgeCost {
    // Real Office-engine round-trip: high fidelity, but a heavyweight,
    // slow hop compared to the pure-JS converters in this directory.
    return { retention: 0.95, effort: 8, structure: 0.95 };
  },

  async availability() {
    const probe = await probeSoffice();
    if (!probe) {
      return {
        available: false,
        reason: 'LibreOffice not installed',
        remedy: 'Install LibreOffice for higher-fidelity Office conversions.',
      };
    }
    return { available: true, version: probe.version };
  },

  async convert(
    input: ConversionInput,
    output: ConversionOutput,
    _options: ConverterOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    if (ctx.signal.aborted) {
      throw new ConversionError({
        code: 'E_CANCELLED',
        userMessage: 'The conversion was cancelled.',
        retryable: false,
      });
    }

    const edge = findEdge(input.format, output.format);
    if (!edge) {
      throw new ConversionError({
        code: 'E_UNSUPPORTED_FEATURE',
        userMessage: `Converting "${input.format}" to "${output.format}" via LibreOffice is not supported.`,
        retryable: false,
      });
    }

    const probe = await probeSoffice();
    if (!probe) {
      throw new ConversionError({
        code: 'E_UNAVAILABLE',
        userMessage: 'LibreOffice is not installed.',
        detail: 'Install LibreOffice for higher-fidelity Office conversions.',
        retryable: false,
      });
    }

    ctx.onProgress({ ratio: 0, message: 'Starting LibreOffice' });

    const userInstallDir = `file:///tmp/fw-${randomUUID()}`;
    const args = [
      '--headless',
      '--norestore',
      '--invisible',
      '--nolockcheck',
      '--nodefault',
      '--convert-to',
      edge.targetExt,
      '--outdir',
      ctx.scratchDir,
      input.path,
      `-env:UserInstallation=${userInstallDir}`,
    ];

    try {
      const { execa } = await import('execa');
      await execa(probe.path, args, { cancelSignal: ctx.signal, timeout: 120_000 });
    } catch (cause) {
      if (ctx.signal.aborted) {
        throw new ConversionError({
          code: 'E_CANCELLED',
          userMessage: 'The conversion was cancelled.',
          retryable: false,
        });
      }
      throw new ConversionError({
        code: 'E_ENGINE',
        userMessage: 'LibreOffice could not convert this file.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.8, message: 'Collecting output' });

    // `--convert-to` names its output `<input-basename>.<targetExt>` and
    // writes it into `--outdir`, ignoring whatever filename the caller
    // actually wants — move it into place ourselves.
    const producedName = `${basename(input.path, extname(input.path))}.${edge.targetExt}`;
    const producedPath = join(ctx.scratchDir, producedName);

    if (!(await fileExists(producedPath))) {
      const scratchEntries = await readdir(ctx.scratchDir).catch(() => [] as string[]);
      throw new ConversionError({
        code: 'E_ENGINE',
        userMessage: 'LibreOffice did not produce an output file.',
        detail: `Expected "${producedPath}". Scratch dir contains: ${scratchEntries.join(', ') || '(empty)'}`,
        retryable: true,
      });
    }

    try {
      await rename(producedPath, output.path);
    } catch {
      // Cross-device rename (EXDEV) — fall back to copy + delete.
      await copyFile(producedPath, output.path);
      await unlink(producedPath).catch(() => undefined);
    }

    ctx.onProgress({ ratio: 1, message: 'Done' });

    return {};
  },
};
