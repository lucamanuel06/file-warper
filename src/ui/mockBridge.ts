/**
 * DEV-ONLY fake `window.warp`, installed when Electron's real preload bridge
 * isn't present (e.g. `next dev` in a plain browser tab). Lets the UI be
 * built and demoed standalone while W2 finishes the real IPC surface.
 * Approximation, not a router: same-category formats are "reachable", cross-
 * category isn't — enough to demo mixed-drop dimming/auto-switch.
 */
import {
  canWrite,
  extensionFor,
  FORMATS,
  formatFromFilename,
  getFormat,
} from '@core/formats';
import type {
  Availability,
  BatchId,
  ConverterOptions,
  FormatId,
  JobId,
  ProbeResult,
  TargetSet,
} from '@core/types';
import type { IpcInvokeMap, WarpApi, WarpEvent } from '@shared/ipc';

const registry = new Map<string, { name: string; size: number }>();
const listeners = new Set<(e: WarpEvent[]) => void>();
const cancelledJobs = new Set<JobId>();
const cancelledBatches = new Set<BatchId>();
let seq = 0;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emit = (events: WarpEvent[]) => {
  for (const l of listeners) l(events);
};
const isCancelled = (batchId: BatchId, jobId: JobId) =>
  cancelledBatches.has(batchId) || cancelledJobs.has(jobId);

function synthPath(name: string, size: number): string {
  const path = `/mock/${seq++}-${name}`;
  registry.set(path, { name, size });
  return path;
}

function reachableTargets(format: FormatId): FormatId[] {
  const cat = getFormat(format)?.category;
  return cat
    ? FORMATS.filter((f) => f.category === cat && canWrite(f.id)).map((f) => f.id)
    : [];
}

function targetsFor(formats: FormatId[]): TargetSet {
  const uniq = [...new Set(formats)];
  const sets = uniq.map((f) => new Set(reachableTargets(f)));
  const common: FormatId[] = [];
  const partial: Record<FormatId, FormatId[]> = {};
  for (const t of new Set(sets.flatMap((s) => [...s]))) {
    const reaching = uniq.filter((_, i) => sets[i]?.has(t));
    if (reaching.length === uniq.length) common.push(t);
    else partial[t] = reaching;
  }
  return { common, partial };
}

function probe(paths: string[]): ProbeResult[] {
  return paths.map((path) => {
    const rec = registry.get(path);
    const name = rec?.name ?? path.split('/').pop() ?? path;
    const format = formatFromFilename(name) ?? null;
    return {
      path,
      name,
      size: rec?.size ?? 128_000,
      format,
      category: format ? (getFormat(format)?.category ?? null) : null,
      confidence: format ? ('extension' as const) : ('none' as const),
      warnings: [],
    };
  });
}

function optionsFor(target: FormatId): ConverterOptions {
  switch (getFormat(target)?.category) {
    case 'image':
      return { quality: 'balanced', maxSize: 'original' };
    case 'audio':
      return { quality: 'balanced', channels: 'keep' };
    case 'video':
      return { quality: 'balanced', resolution: 'original' };
    case 'data':
      return { flatten: false };
    default:
      return {};
  }
}

function buildJob(path: string, target: FormatId, batchId: BatchId) {
  const p = probe([path])[0];
  const inputFormat = p?.format ?? null;
  const reachable = !!inputFormat && reachableTargets(inputFormat).includes(target);
  return {
    id: `job-${seq++}`,
    batchId,
    inputPath: path,
    inputName: p?.name ?? path,
    inputFormat,
    target,
    outputPath: `${path.replace(/\.[^./]+$/, '')}.${extensionFor(target)}`,
    state: reachable ? ('queued' as const) : ('skipped' as const),
    hops: 1,
    lossless: true,
  };
}

async function simulateBatch(
  batchId: BatchId,
  jobs: { id: JobId; outputPath: string; state: string }[],
) {
  let ok = 0;
  let skipped = 0;
  for (const job of jobs) {
    if (job.state === 'skipped') {
      skipped++;
      continue;
    }
    if (isCancelled(batchId, job.id)) continue;
    emit([{ t: 'job:state', jobId: job.id, state: 'running' }]);
    for (const progress of [0.5, 1]) {
      await delay(150);
      if (isCancelled(batchId, job.id)) break;
      emit([{ t: 'job:progress', jobId: job.id, progress, hop: { index: 0, total: 1 } }]);
    }
    if (isCancelled(batchId, job.id)) {
      emit([{ t: 'job:state', jobId: job.id, state: 'cancelled' }]);
      continue;
    }
    emit([{ t: 'job:state', jobId: job.id, state: 'succeeded' }]);
    emit([
      {
        t: 'job:done',
        jobId: job.id,
        outputPath: job.outputPath,
        bytes: 128_000,
        warnings: [],
      },
    ]);
    ok++;
  }
  emit([{ t: 'batch:done', batchId, ok, failed: 0, skipped }]);
}

/** Canned files so "click to browse" is demoable without a real file picker. */
const DEMO_FILES = [
  { name: 'photo.jpg', size: 2_400_000 },
  { name: 'scan.png', size: 1_100_000 },
  { name: 'clip.mp4', size: 8_200_000 },
];

async function invokeImpl(channel: string, ...args: unknown[]): Promise<unknown> {
  switch (channel) {
    case 'dialog:pickFiles':
      return DEMO_FILES.map((f) => synthPath(f.name, f.size));
    case 'dialog:pickFolder':
      return '/mock/Desktop';
    case 'warp:probe':
      return probe(args[0] as string[]);
    case 'warp:targets':
      return targetsFor(args[0] as FormatId[]);
    case 'warp:enqueue': {
      const req = args[0] as { paths: string[]; target: FormatId };
      const batchId = `batch-${seq++}`;
      const jobs = req.paths.map((p) => buildJob(p, req.target, batchId));
      void simulateBatch(batchId, jobs);
      return { batchId, jobs };
    }
    case 'warp:cancelJob':
      cancelledJobs.add(args[0] as JobId);
      return undefined;
    case 'warp:cancelBatch':
      cancelledBatches.add(args[0] as BatchId);
      return undefined;
    case 'warp:availability':
      return { mock: { available: true, version: 'dev' } as Availability };
    case 'warp:optionsFor':
      return optionsFor(args[0] as FormatId);
    case 'temp:spill': {
      const [name, bytes] = args as [string, ArrayBuffer];
      return synthPath(name, bytes.byteLength);
    }
    case 'shell:reveal':
      console.info('[mockBridge] reveal', args[0]);
      return undefined;
    case 'app:info':
      return { version: '0.0.0-dev', isPackaged: false };
    default:
      throw new Error(`[mockBridge] unhandled channel: ${channel}`);
  }
}

export function installMockBridge(): void {
  if (typeof window === 'undefined' || window.warp) return;
  const api: WarpApi = {
    invoke: (<C extends keyof IpcInvokeMap>(channel: C, ...args: unknown[]) =>
      invokeImpl(channel, ...args)) as WarpApi['invoke'],
    on: (_event, cb) => {
      const handler = cb as (e: WarpEvent[]) => void;
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    pathsForFiles: (files) => files.map((f) => synthPath(f.name, f.size)),
  };
  window.warp = api;
  console.info('[mockBridge] installed — window.warp is a dev-only fake');
}
