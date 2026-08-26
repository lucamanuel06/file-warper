/**
 * Wires every channel in `IpcInvokeMap` (src/shared/ipc.ts, frozen). One
 * channel of events flows the other way (`warp:events`), coalesced per job
 * and flushed at 10 Hz — see `startEventPump` below.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ALL_CONVERTERS } from '@converters/index';
import { probeFile } from '@core/detect';
import type { EnqueueRequest, JobId, ProbeResult } from '@core/types';
import type { WarpEvent } from '@shared/ipc';
import type { AppSettings } from '@shared/settings';
import { type BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { sanitizeBasename } from '../runtime/naming';
import type { Scheduler } from '../runtime/scheduler';
import * as temp from '../runtime/temp';
import { resolveBinary } from './resolveBinary';
import * as settings from './settings';
import { checkForUpdates } from './updates';

/** Only ever pass a validated URL to `shell.openExternal` — never a raw string. */
function isAllowedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);
const FLUSH_INTERVAL_MS = 100;

export async function pickFiles(win: BrowserWindow): Promise<string[]> {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    // No `filters` — this app converts ANY file type. A filter here is a lie.
  });
  return result.canceled ? [] : result.filePaths;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}
interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

async function enrichMedia(filePath: string): Promise<ProbeResult['media'] | undefined> {
  let ffprobePath: string;
  try {
    ffprobePath = resolveBinary('ffprobe');
  } catch {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const hasAudio = streams.some((s) => s.codec_type === 'audio');
    return {
      durationSec: parsed.format?.duration ? Number(parsed.format.duration) : undefined,
      hasVideo: Boolean(video),
      hasAudio,
      width: video?.width,
      height: video?.height,
    };
  } catch {
    return undefined;
  }
}

async function probeOnePath(filePath: string): Promise<ProbeResult[]> {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) {
    return [
      {
        path: filePath,
        name: path.basename(filePath),
        size: 0,
        format: null,
        category: null,
        confidence: 'none',
        warnings: ["This file couldn't be read."],
      },
    ];
  }

  if (stat.isDirectory()) {
    const entries = await fsp.readdir(filePath, { withFileTypes: true });
    const results: ProbeResult[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      results.push(...(await probeOnePath(path.join(filePath, entry.name))));
    }
    return results;
  }

  const result = await probeFile(filePath);
  if (result.category === 'audio' || result.category === 'video') {
    const media = await enrichMedia(filePath);
    return [media ? { ...result, media } : result];
  }
  return [result];
}

export interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  scheduler: Scheduler;
}

export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.handle('dialog:pickFiles', async () => {
    const win = deps.getWindow();
    return win ? pickFiles(win) : [];
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const win = deps.getWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return result.canceled || result.filePaths.length === 0
      ? null
      : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('warp:probe', async (_e, paths: string[]) => {
    const results: ProbeResult[] = [];
    for (const p of paths) results.push(...(await probeOnePath(p)));
    return results;
  });

  ipcMain.handle('warp:targets', async (_e, formats) =>
    deps.scheduler.targetsFor(formats),
  );

  ipcMain.handle('warp:enqueue', async (_e, req: EnqueueRequest) =>
    deps.scheduler.enqueue(req),
  );

  ipcMain.handle('warp:cancelJob', async (_e, jobId: JobId) => {
    deps.scheduler.cancelJob(jobId);
  });

  ipcMain.handle('warp:cancelBatch', async (_e, batchId) => {
    deps.scheduler.cancelBatch(batchId);
  });

  ipcMain.handle('warp:availability', async () => {
    await deps.scheduler.refreshAvailability();
    return deps.scheduler.availabilitySnapshot();
  });

  ipcMain.handle('warp:optionsFor', async (_e, target: string) => {
    // Merge the CommonOptions baseline with the defaults declared by whichever
    // converters can actually produce `target`. Cheap, and it means the UI's
    // Options disclosure reflects the real engine rather than a hardcoded guess.
    const defaults: Record<string, unknown> = {
      preserveMetadata: true,
      deterministic: false,
    };
    for (const converter of ALL_CONVERTERS) {
      if (!converter.outputs.includes(target)) continue;
      Object.assign(defaults, converter.defaultOptions ?? {});
    }
    return defaults;
  });

  ipcMain.handle('temp:spill', async (_e, name: string, bytes: ArrayBuffer) => {
    const dir = path.join(temp.sessionRoot(), 'spill');
    await fsp.mkdir(dir, { recursive: true });
    const safeName = sanitizeBasename(name || 'file');
    const target = path.join(dir, `${randomUUID()}-${safeName}`);
    await fsp.writeFile(target, Buffer.from(bytes));
    return target;
  });

  ipcMain.handle('shell:reveal', async (_e, p: string) => {
    shell.showItemInFolder(p);
  });

  ipcMain.handle('app:info', async () => {
    const { app } = await import('electron');
    return { version: app.getVersion(), isPackaged: app.isPackaged };
  });

  ipcMain.handle('settings:get', async () => settings.get());

  ipcMain.handle('settings:set', async (_e, patch: Partial<AppSettings>) =>
    settings.patch(patch),
  );

  ipcMain.handle('update:check', async (_e, opts?: { manual?: boolean }) =>
    checkForUpdates(opts),
  );

  ipcMain.handle('update:open', async (_e, url: string) => {
    if (!isAllowedExternalUrl(url)) {
      throw new Error('Refusing to open a non-GitHub URL.');
    }
    await shell.openExternal(url);
  });
}

/**
 * Coalesces per-jobId and flushes at 10 Hz — `job:state` transitions are
 * never dropped, only `job:progress` is. `warp:events` is ALWAYS sent as an
 * array, per the frozen contract.
 */
export function startEventPump(
  scheduler: Scheduler,
  getWindow: () => BrowserWindow | null,
): () => void {
  const stateAndTerminalEvents: WarpEvent[] = [];
  const latestProgressByJob = new Map<JobId, WarpEvent>();

  const onEvent = (e: WarpEvent) => {
    if (e.t === 'job:progress') {
      latestProgressByJob.set(e.jobId, e);
    } else {
      stateAndTerminalEvents.push(e);
    }
  };
  scheduler.on('event', onEvent);

  const timer = setInterval(() => {
    if (stateAndTerminalEvents.length === 0 && latestProgressByJob.size === 0) return;
    const batch = [...stateAndTerminalEvents, ...latestProgressByJob.values()];
    stateAndTerminalEvents.length = 0;
    latestProgressByJob.clear();
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('warp:events', batch);
  }, FLUSH_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    scheduler.off('event', onEvent);
  };
}
