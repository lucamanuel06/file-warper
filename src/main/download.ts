/**
 * In-app download of a release asset.
 *
 * Deliberately narrow: this is not a general downloader. The URL must live
 * under this project's own releases prefix, the file always lands in the
 * user's Downloads folder, and only one download runs at a time. Everything
 * else the app does is still fully offline.
 *
 * Nothing here installs anything — see the note in src/shared/settings.ts for
 * why File Warper notifies and downloads rather than replacing itself in
 * place. The user still double-clicks the installer.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { UpdateDownloadProgress } from '@shared/ipc';
import { RELEASES_PAGE_URL } from '@shared/settings';
import { app, net } from 'electron';
import { sanitizeBasename } from '../runtime/naming';

/**
 * `https://github.com/<owner>/<repo>/releases/download/`. Derived from the
 * frozen constant so a repo rename cannot leave this pointing somewhere else.
 */
const ASSET_URL_PREFIX = `${RELEASES_PAGE_URL.replace(/\/releases\/latest$/, '')}/releases/download/`;

/** Progress frames are throttled to this; terminal states always go through. */
const PROGRESS_INTERVAL_MS = 120;

const NETWORK_ERROR_MESSAGE =
  'The download stopped. Check your connection and try again.';
const DISK_ERROR_MESSAGE = "The download couldn't be saved. Check your Downloads folder.";

export class DownloadError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'DownloadError';
  }
}

/** Only ever download from this project's own release assets. */
export function isReleaseAssetUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      raw.startsWith(ASSET_URL_PREFIX)
    );
  } catch {
    return false;
  }
}

/** `.../File.Warper-1.3.2-arm64.dmg` -> `File.Warper-1.3.2-arm64.dmg`. */
function filenameFor(rawUrl: string): string {
  let last = '';
  try {
    last = decodeURIComponent(new URL(rawUrl).pathname.split('/').pop() ?? '');
  } catch {
    last = '';
  }
  return sanitizeBasename(last) || 'file-warper-update';
}

/**
 * `File.Warper.dmg` -> `File.Warper (1).dmg` when the first is taken. The
 * suffix goes before the extension so the OS still knows what the file is.
 */
async function freePath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n === 0 ? filename : `${stem} (${n})${ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
}

let inFlight: AbortController | null = null;

export function cancelDownload(): void {
  inFlight?.abort();
  inFlight = null;
}

export function isDownloading(): boolean {
  return inFlight !== null;
}

export interface DownloadDeps {
  /** Called for every progress frame, including the terminal one. */
  readonly onProgress: (p: UpdateDownloadProgress) => void;
  /** Overridable for tests. */
  readonly downloadsDir?: string;
}

/**
 * Streams the asset to disk, reporting progress. Resolves with the final path.
 *
 * The bytes go to a `.part` file that is renamed only after the stream closes
 * cleanly, so a cancelled or interrupted download can never leave something in
 * Downloads that looks like a complete installer.
 */
export async function downloadUpdate(url: string, deps: DownloadDeps): Promise<string> {
  if (!isReleaseAssetUrl(url)) {
    throw new DownloadError('That download link is not a File Warper release.');
  }

  cancelDownload();
  const controller = new AbortController();
  inFlight = controller;

  const dir = deps.downloadsDir ?? app.getPath('downloads');
  await fsp.mkdir(dir, { recursive: true });
  const finalPath = await freePath(dir, filenameFor(url));
  const partPath = `${finalPath}.part`;

  let received = 0;
  let total = 0;
  let lastEmit = 0;

  const emit = (p: UpdateDownloadProgress) => deps.onProgress(p);
  const emitProgress = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    emit({
      state: 'downloading',
      received,
      total,
      // -1, not 0: a server with no Content-Length must render as an
      // indeterminate bar rather than as "stuck at 0%".
      ratio: total > 0 ? Math.min(received / total, 1) : -1,
    });
  };

  let handle: fsp.FileHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const response = await net.fetch(url, {
      headers: { 'User-Agent': `FileWarper/${app.getVersion()}` },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new DownloadError(NETWORK_ERROR_MESSAGE);
    }

    total = Number(response.headers.get('content-length') ?? 0) || 0;
    emitProgress(true);

    handle = await fsp.open(partPath, 'w');
    reader = response.body.getReader();

    // Racing the read against the signal rather than trusting the stream to
    // honour it: a cancel must take effect at once, and a socket that has gone
    // quiet mid-transfer would otherwise leave Cancel doing nothing visible.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    });

    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (value) {
        await handle.write(value);
        received += value.byteLength;
        emitProgress(false);
      }
    }

    await handle.close();
    handle = undefined;

    // A truncated response that still ends the stream cleanly is the one
    // failure mode that would otherwise produce a corrupt installer.
    if (total > 0 && received !== total) {
      throw new DownloadError(NETWORK_ERROR_MESSAGE);
    }

    await fsp.rename(partPath, finalPath);

    emit({ state: 'done', received, total, ratio: 1, path: finalPath });
    return finalPath;
  } catch (err) {
    // Cancel the reader too, or the socket keeps pulling bytes we discard.
    await reader?.cancel().catch(() => {});
    await handle?.close().catch(() => {});
    fs.rmSync(partPath, { force: true });

    if (controller.signal.aborted) {
      emit({ state: 'cancelled', received, total, ratio: 0 });
      throw new DownloadError('Download cancelled.');
    }

    const message =
      err instanceof DownloadError
        ? err.userMessage
        : err instanceof Error && /EACCES|EPERM|ENOSPC|EROFS/.test(err.message)
          ? DISK_ERROR_MESSAGE
          : NETWORK_ERROR_MESSAGE;

    emit({ state: 'error', received, total, ratio: 0, message });
    throw new DownloadError(message);
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}
