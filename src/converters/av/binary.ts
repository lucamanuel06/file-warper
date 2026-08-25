import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import type { Availability } from '@core/types';

/**
 * W2 owns `src/main/resolveBinary.ts`, which may not exist on this branch.
 * This is a small local resolver so av converters don't block on that:
 * env override -> packaged `resourcesPath/bin/<name>` -> the npm-resolved
 * dev path. Reconcile with W2's helper at integration time.
 */
async function resolveNpmFfmpeg(): Promise<string | null> {
  try {
    const mod = (await import('ffmpeg-static')) as unknown as
      | string
      | { default?: string };
    const p = typeof mod === 'string' ? mod : mod.default;
    return typeof p === 'string' && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

async function resolveNpmFfprobe(): Promise<string | null> {
  try {
    const mod = (await import('@ffprobe-installer/ffprobe')) as unknown as {
      path?: string;
      default?: { path?: string };
    };
    const p = mod.path ?? mod.default?.path;
    return typeof p === 'string' && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

async function resolveBinary(
  envVar: string,
  binName: string,
  npmResolve: () => Promise<string | null>,
): Promise<string | null> {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;

  // Electron sets this in the main process; plain Node (tests, dev outside
  // Electron) doesn't have it, despite @types/node declaring it as `string`.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'bin', binName);
    if (existsSync(packaged)) return packaged;
  }

  return npmResolve();
}

let cachedFfmpeg: string | null | undefined;
let cachedFfprobe: string | null | undefined;

export async function resolveFfmpegPath(): Promise<string | null> {
  if (cachedFfmpeg === undefined) {
    cachedFfmpeg = await resolveBinary('WARP_FFMPEG_PATH', 'ffmpeg', resolveNpmFfmpeg);
  }
  return cachedFfmpeg;
}

export async function resolveFfprobePath(): Promise<string | null> {
  if (cachedFfprobe === undefined) {
    cachedFfprobe = await resolveBinary(
      'WARP_FFPROBE_PATH',
      'ffprobe',
      resolveNpmFfprobe,
    );
  }
  return cachedFfprobe;
}

export function resetBinaryCacheForTests(): void {
  cachedFfmpeg = undefined;
  cachedFfprobe = undefined;
}

export async function checkExecutable(
  binaryPath: string | null,
  label: string,
): Promise<Availability> {
  if (!binaryPath) {
    return {
      available: false,
      reason: `${label} could not be located.`,
      remedy:
        'Reinstall File Warper, or set the WARP_FFMPEG_PATH/WARP_FFPROBE_PATH environment variable.',
    };
  }
  try {
    await access(binaryPath, constants.X_OK);
    return { available: true };
  } catch {
    return {
      available: false,
      reason: `${label} is not executable at ${binaryPath}.`,
      remedy: 'Check file permissions, or reinstall File Warper.',
    };
  }
}
