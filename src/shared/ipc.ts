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
import type { AppSettings, UpdateStatus } from './settings';

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

  /** Persisted user settings — see src/shared/settings.ts. */
  'settings:get': () => Promise<AppSettings>;
  /** Merges a patch, persists, and returns the full resulting settings. */
  'settings:set': (patch: Partial<AppSettings>) => Promise<AppSettings>;

  /**
   * Asks GitHub for the latest release. `manual: true` bypasses both the 24h
   * throttle and the `checkForUpdates` setting (the user pressed "Check now").
   */
  'update:check': (opts?: { manual?: boolean }) => Promise<UpdateStatus>;
  /** Opens a release URL in the default browser. */
  'update:open': (url: string) => Promise<void>;

  /**
   * Downloads a release asset inside the app instead of handing it to the
   * browser. Resolves with the absolute path it landed on (under the user's
   * Downloads folder). Progress arrives on the `update:progress` event; call
   * `update:cancelDownload` to abort.
   *
   * Main re-validates the URL against the project's own releases prefix, so a
   * renderer cannot turn this into a general-purpose downloader.
   */
  'update:download': (url: string) => Promise<string>;
  /** Aborts the download in flight. No-op when nothing is downloading. */
  'update:cancelDownload': () => Promise<void>;
  /** Reveals a finished download in Finder/Explorer/the file manager. */
  'update:revealDownload': (path: string) => Promise<void>;
}

/**
 * Progress for the in-app update download. `total` is 0 and `ratio` is -1 when
 * the server sends no Content-Length — the UI must render that indeterminately
 * rather than as 0%.
 */
export interface UpdateDownloadProgress {
  readonly state: 'downloading' | 'done' | 'error' | 'cancelled';
  readonly received: number;
  readonly total: number;
  readonly ratio: number;
  /** Set when `state` is 'done'. */
  readonly path?: string;
  /** Set when `state` is 'error'; already phrased for a human. */
  readonly message?: string;
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

  /**
   * NOT an array — unlike `warp:events` there is at most one update download
   * at a time, so there is nothing to coalesce across. Main throttles the
   * `downloading` frames itself; the terminal states are never dropped.
   */
  'update:progress': UpdateDownloadProgress;
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
  'settings:get',
  'settings:set',
  'update:check',
  'update:open',
  'update:download',
  'update:cancelDownload',
  'update:revealDownload',
] as const satisfies readonly (keyof IpcInvokeMap)[];

export const EVENT_CHANNELS = [
  'warp:events',
  'update:progress',
] as const satisfies readonly (keyof IpcEventMap)[];

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
