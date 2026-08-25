/**
 * FROZEN CONTRACT.
 *
 * Every workstream codes against this file. Do not change a type here without
 * saying so explicitly in your final report — a silent change breaks the other
 * four builders.
 *
 * This module is part of `@warp/core`: pure TypeScript, ZERO runtime
 * dependencies, no `electron`, no native modules. It is bundled into the
 * Next.js renderer, so anything imported here ends up in the browser graph.
 */

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export type FormatId = string;

export type FormatCategory =
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'data'
  | 'archive'
  | 'font'
  | 'subtitle'
  | 'other';

/** A magic-byte signature. `bytes` is lowercase hex, optionally masked. */
export interface MagicSig {
  readonly offset: number;
  readonly bytes: string;
  /** Same length as `bytes`; `ff` = compare, `00` = ignore. */
  readonly mask?: string;
}

export interface FormatDef {
  /** Lowercase, canonical, stable forever. */
  readonly id: FormatId;
  /** Human label, e.g. 'JPEG Image'. */
  readonly label: string;
  readonly category: FormatCategory;
  /** `[0]` is canonical and is used for output naming. No leading dot. */
  readonly extensions: readonly string[];
  /** Ids a user might type that normalize to `id`, e.g. 'jpg' -> 'jpeg'. */
  readonly aliases?: readonly string[];
  readonly mime: string;
  /** false for text formats (json, csv, md, svg, ...). */
  readonly binary: boolean;
  /** The format is inherently lossy (jpeg, mp3, h264). */
  readonly lossy: boolean;
  readonly animated?: boolean;
  /** Holds heterogeneous payloads: mkv, mp4, zip, docx. */
  readonly container?: boolean;
  /** Routing hub. Converters should route through these instead of N^2 edges. */
  readonly hub?: boolean;
  /** We can read it, never write it: doc, psd, rar, heic. */
  readonly readOnly?: boolean;
  readonly magic?: readonly MagicSig[];
  /** 3 = show first in the UI, 0 = long tail. */
  readonly popularity: 0 | 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

export type ConverterId = string;
export type EngineId =
  | 'sharp'
  | 'ffmpeg'
  | 'chromium'
  | 'pure-js'
  | 'libreoffice'
  | (string & {});

/** Where a hop must physically execute. */
export type Residency =
  /** Default: the utilityProcess worker pool. */
  | 'worker'
  /** Needs Electron main APIs (BrowserWindow.printToPDF, offscreen canvas). */
  | 'main';

export interface EdgeCost {
  /** Quality retained through this hop, 0..1. 1 = lossless. Multiplicative. */
  readonly retention: number;
  /** Relative cost hint. 1 = trivial, 10 = transcode a video. Tie-breaker only. */
  readonly effort: number;
  /** Structural fidelity retained (layout, metadata, layers, tags), 0..1. */
  readonly structure?: number;
}

export type Availability =
  | { readonly available: true; readonly version?: string }
  | { readonly available: false; readonly reason: string; readonly remedy?: string };

export interface ConversionInput {
  readonly path: string;
  readonly format: FormatId;
  readonly size: number;
  /** Opt-in for pure-JS engines. NEVER call this on video. */
  readBuffer(): Promise<Buffer>;
  createReadStream(): NodeJS.ReadableStream;
}

export interface ConversionOutput {
  /** Absolute path the converter MUST write to. Parent dir already exists. */
  readonly path: string;
  readonly format: FormatId;
}

export interface ProgressEvent {
  /** 0..1 within this hop. Use -1 for indeterminate. */
  readonly ratio: number;
  readonly message?: string;
}

export interface ConvertContext {
  onProgress(e: ProgressEvent): void;
  /** Aborted on user cancel, batch cancel, or app quit. Converters MUST honour it. */
  readonly signal: AbortSignal;
  /** Scratch dir owned by the executor; auto-deleted. Safe for engine spill files. */
  readonly scratchDir: string;
  log(msg: string, data?: unknown): void;
}

export interface ConvertResult {
  readonly bytes?: number;
  /** Non-fatal notes surfaced in the UI ("dropped alpha channel"). */
  readonly warnings?: string[];
  /** Engine-observed metadata, cached for later hops. */
  readonly meta?: Record<string, unknown>;
}

/** Declarative descriptor so the renderer can render an options form. */
export interface OptionsSchema {
  readonly fields: readonly OptionField[];
}

export type OptionField =
  | {
      readonly key: string;
      readonly kind: 'segmented';
      readonly label: string;
      readonly choices: readonly { value: string; label: string }[];
      readonly default: string;
    }
  | {
      readonly key: string;
      readonly kind: 'select';
      readonly label: string;
      readonly choices: readonly { value: string; label: string }[];
      readonly default: string;
    }
  | {
      readonly key: string;
      readonly kind: 'toggle';
      readonly label: string;
      readonly default: boolean;
    };

export interface CommonOptions {
  /** Strip timestamps/producer strings so output is byte-reproducible. Tests set true. */
  readonly deterministic?: boolean;
  /** Preserve EXIF/ID3/XMP where the target supports it. Default true. */
  readonly preserveMetadata?: boolean;
}

export type ConverterOptions = Record<string, unknown> & CommonOptions;

export interface Converter {
  readonly id: ConverterId;
  readonly name: string;
  readonly engine: EngineId;
  /** Default 'worker'. */
  readonly residency?: Residency;

  readonly inputs: readonly FormatId[];
  readonly outputs: readonly FormatId[];

  /**
   * Prunes the inputs x outputs cartesian product. Return false for pairs this
   * converter declares but cannot actually do. Omit if the full product is valid.
   */
  supports?(from: FormatId, to: FormatId): boolean;

  /** Per-pair cost. A constant object is fine when the pair does not matter. */
  cost(from: FormatId, to: FormatId): EdgeCost;

  /** Cheap, cached, NEVER throws. A missing binary is a normal state. */
  availability(): Promise<Availability>;

  readonly optionsSchema?: OptionsSchema;
  readonly defaultOptions?: ConverterOptions;

  convert(
    input: ConversionInput,
    output: ConversionOutput,
    options: ConverterOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult>;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface RouteStep {
  readonly converterId: ConverterId;
  readonly from: FormatId;
  readonly to: FormatId;
}

export interface Route {
  readonly from: FormatId;
  readonly to: FormatId;
  /** Length 1..maxHops. */
  readonly steps: readonly RouteStep[];
  readonly totalWeight: number;
  /** Product of step retentions. Drives the UI "lossless" badge. */
  readonly retention: number;
  readonly lossless: boolean;
}

export interface Edge {
  readonly from: FormatId;
  readonly to: FormatId;
  readonly converterId: ConverterId;
  readonly weight: number;
  readonly cost: EdgeCost;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ConversionErrorCode =
  | 'E_NO_ROUTE'
  | 'E_UNAVAILABLE'
  | 'E_CORRUPT_INPUT'
  | 'E_UNSUPPORTED_FEATURE'
  | 'E_DISK_FULL'
  | 'E_PERMISSION'
  | 'E_TIMEOUT'
  | 'E_CANCELLED'
  | 'E_WORKER_CRASH'
  | 'E_ENGINE';

export class ConversionError extends Error {
  readonly code: ConversionErrorCode;
  /** Shown in the UI. Must be a sentence a non-technical person understands. */
  readonly userMessage: string;
  /** Engine stderr etc. Shown behind "Details". */
  readonly detail?: string;
  readonly step?: RouteStep;
  readonly retryable: boolean;

  constructor(init: {
    code: ConversionErrorCode;
    userMessage: string;
    detail?: string;
    step?: RouteStep;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(`${init.code}: ${init.userMessage}`, { cause: init.cause });
    this.name = 'ConversionError';
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.detail = init.detail;
    this.step = init.step;
    this.retryable = init.retryable ?? false;
  }
}

export interface SerializedError {
  readonly code: ConversionErrorCode;
  readonly userMessage: string;
  readonly detail?: string;
  readonly retryable: boolean;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobId = string;
export type BatchId = string;

export type JobState =
  | 'queued'
  | 'routing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type CollisionPolicy = 'suffix' | 'overwrite' | 'skip' | 'timestamp';

export type OutputLocation =
  | { readonly mode: 'alongside' }
  | { readonly mode: 'fixed'; readonly dir: string }
  | { readonly mode: 'mirror'; readonly root: string; readonly sourceRoot: string };

export interface ProbeResult {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly format: FormatId | null;
  readonly category: FormatCategory | null;
  /** 'magic' | 'extension' | 'sniff' | 'none' */
  readonly confidence: 'magic' | 'extension' | 'sniff' | 'none';
  readonly warnings: readonly string[];
  /** ffprobe-derived facts for A/V, so the UI can hide impossible targets. */
  readonly media?: {
    readonly durationSec?: number;
    readonly hasVideo?: boolean;
    readonly hasAudio?: boolean;
    readonly width?: number;
    readonly height?: number;
  };
}

export interface TargetSet {
  /** Reachable from EVERY selected input. Fully enabled in the UI. */
  readonly common: readonly FormatId[];
  /** Reachable from some inputs: formatId -> the input formats that reach it. */
  readonly partial: Readonly<Record<FormatId, readonly FormatId[]>>;
}

export interface EnqueueRequest {
  readonly paths: readonly string[];
  readonly target: FormatId;
  readonly options: ConverterOptions;
  readonly output: OutputLocation;
  readonly collision?: CollisionPolicy;
}

export interface JobSummary {
  readonly id: JobId;
  readonly batchId: BatchId;
  readonly inputPath: string;
  readonly inputName: string;
  readonly inputFormat: FormatId | null;
  readonly target: FormatId;
  readonly outputPath: string;
  readonly state: JobState;
  readonly hops: number;
  readonly lossless: boolean;
}
