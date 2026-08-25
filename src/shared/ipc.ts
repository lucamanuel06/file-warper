/**
 * FROZEN CONTRACT — the entire main <-> renderer surface.
 *
 * TYPES AND CONSTANTS ONLY. Never `import { ipcRenderer } from 'electron'` in
 * this file or anything it imports: `src/shared` is compiled into the Next.js
 * browser graph, and an `electron` import there breaks the renderer build.
 */

import type {
  Availability,
  BatchId,
  ConverterOptions,
  EnqueueRequest,
  FormatId,
  JobId,
  JobState,
  JobSummary,
  ProbeResult,
  SerializedError,
  TargetSet,
} from '../core/types';

// ---------------------------------------------------------------------------
// Renderer -> main (request/response)
// ---------------------------------------------------------------------------

export interface IpcInvokeMap {
  /** Native open dialog. Returns absolute paths; `[]` when cancelled. */
  'dialog:pickFiles': () => Promise<string[]>;
  /** Native directory chooser. `null` when cancelled. */
  'dialog:pickFolder': () => Promise<string | null>;

  /** Detect format + media facts for each path. Folders expand one level. */
  'warp:probe': (paths: string[]) => Promise<ProbeResult[]>;
  /** Which targets are reachable from this set of input formats. */
  'warp:targets': (formats: FormatId[]) => Promise<TargetSet>;
  /** Queue a batch. Routing happens here, so unroutable files come back `skipped`. */
  'warp:enqueue': (
    req: EnqueueRequest,
  ) => Promise<{ batchId: BatchId; jobs: JobSummary[] }>;
  'warp:cancelJob': (jobId: JobId) => Promise<void>;
  'warp:cancelBatch': (batchId: BatchId) => Promise<void>;
  /** Per-converter availability, for the environment banners. */
  'warp:availability': () => Promise<Record<string, Availability>>;
  /** The options schema the UI should render for a given target format. */
  'warp:optionsFor': (target: FormatId) => Promise<ConverterOptions>;

  /**
   * Fallback for dropped Files with no filesystem backing (Mail attachments,
   * Photos.app, un-downloaded iCloud files) where `webUtils.getPathForFile`
   * returns ''. The preload CANNOT write files itself under `sandbox: true`.
   */
  'temp:spill': (name: string, bytes: ArrayBuffer) => Promise<string>;

  'shell:reveal': (path: string) => Promise<void>;
  'app:info': () => Promise<{ version: string; isPackaged: boolean }>;
}

// ---------------------------------------------------------------------------
// Main -> renderer (events)
// ---------------------------------------------------------------------------

export type WarpEvent =
  | { t: 'batch:created'; batchId: BatchId; jobs: JobSummary[] }
  | { t: 'job:state'; jobId: JobId; state: JobState }
  | {
      t: 'job:progress';
      jobId: JobId;
      progress: number;
      hop: { index: number; total: number };
      etaSeconds?: number;
    }
  | {
      t: 'job:done';
      jobId: JobId;
      outputPath: string;
      bytes: number;
      warnings: string[];
    }
  | { t: 'job:error'; jobId: JobId; error: SerializedError }
  | {
      t: 'batch:done';
      batchId: BatchId;
      ok: number;
      failed: number;
      skipped: number;
    };

export interface IpcEventMap {
  /**
   * ALWAYS an array. The scheduler coalesces per job and flushes at 10 Hz —
   * a 500-file batch with per-hop progress would otherwise saturate IPC.
   * `job:state` transitions are never dropped; only `job:progress` is coalesced.
   */
  'warp:events': WarpEvent[];
}

export const INVOKE_CHANNELS = [
  'dialog:pickFiles',
  'dialog:pickFolder',
  'warp:probe',
  'warp:targets',
  'warp:enqueue',
  'warp:cancelJob',
  'warp:cancelBatch',
  'warp:availability',
  'warp:optionsFor',
  'temp:spill',
  'shell:reveal',
  'app:info',
] as const satisfies readonly (keyof IpcInvokeMap)[];

export const EVENT_CHANNELS = ['warp:events'] as const satisfies readonly (keyof IpcEventMap)[];

// ---------------------------------------------------------------------------
// The shape `contextBridge` exposes as `window.warp`
// ---------------------------------------------------------------------------

export interface WarpApi {
  invoke<C extends keyof IpcInvokeMap>(
    channel: C,
    ...args: Parameters<IpcInvokeMap[C]>
  ): ReturnType<IpcInvokeMap[C]>;

  /**
   * Returns its own disposer. This matters: `contextBridge` cannot pass a
   * function reference back across the bridge for a later `off()`, so a
   * renderer that unsubscribes with the raw handler leaks a listener on every
   * re-render.
   */
  on<E extends keyof IpcEventMap>(
    event: E,
    cb: (payload: IpcEventMap[E]) => void,
  ): () => void;

  /**
   * The ONLY correct way to resolve a dropped file to an absolute path
   * (`File.path` was removed in Electron 32). Must be called synchronously in
   * the drop handler — `DataTransfer` is neutered after any `await`.
   * Returns '' for Files with no filesystem backing; spill those via
   * `invoke('temp:spill', ...)`.
   */
  pathsForFiles(files: File[]): string[];
}

declare global {
  interface Window {
    warp: WarpApi;
  }
}
