/**
 * Update checker. Asks GitHub for the latest release and compares it against
 * `app.getVersion()`. Never throws — every failure mode (offline, timeout,
 * rate limit, malformed body) resolves to `{ state: 'error', message }` with
 * a message a normal person can read.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { UpdateStatus } from '@shared/settings';
import {
  RELEASES_API_URL,
  RELEASES_PAGE_URL,
  UPDATE_CHECK_INTERVAL_MS,
} from '@shared/settings';
import { app, net } from 'electron';
import * as settings from './settings';

const TIMEOUT_MS = 8_000;
const NETWORK_ERROR_MESSAGE = "Couldn't reach GitHub. Check your connection.";
const MALFORMED_ERROR_MESSAGE = 'GitHub sent back something unexpected.';

interface UpdateState {
  lastUpdateCheck: number | null;
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function loadState(): UpdateState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(statePath(), 'utf8'),
    ) as Partial<UpdateState>;
    return {
      lastUpdateCheck:
        typeof parsed.lastUpdateCheck === 'number' ? parsed.lastUpdateCheck : null,
    };
  } catch {
    return { lastUpdateCheck: null };
  }
}

function saveState(state: UpdateState): void {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state));
  } catch {
    // Best-effort — losing the throttle timestamp just means one extra check.
  }
}

/** Numeric semver comparison; `1.10.0` > `1.9.0`, unlike a string compare. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function pickDmgUrl(release: GithubRelease): string | null {
  if (!Array.isArray(release.assets)) return null;
  for (const asset of release.assets as GithubAsset[]) {
    if (
      typeof asset?.name === 'string' &&
      asset.name.endsWith('.dmg') &&
      typeof asset.browser_download_url === 'string'
    ) {
      return asset.browser_download_url;
    }
  }
  return null;
}

function friendlyMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return NETWORK_ERROR_MESSAGE;
  if (
    err instanceof Error &&
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(err.message)
  ) {
    return NETWORK_ERROR_MESSAGE;
  }
  return NETWORK_ERROR_MESSAGE;
}

export async function checkForUpdates(opts?: {
  manual?: boolean;
}): Promise<UpdateStatus> {
  const manual = opts?.manual ?? false;
  const now = Date.now();

  if (!manual && !settings.get().checkForUpdates) {
    return { state: 'idle' };
  }

  if (!manual) {
    const { lastUpdateCheck } = loadState();
    if (lastUpdateCheck !== null && now - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) {
      return { state: 'idle' };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await net.fetch(RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `FileWarper/${app.getVersion()}`,
      },
      signal: controller.signal,
    });

    saveState({ lastUpdateCheck: now });

    if (!response.ok) {
      return { state: 'error', message: NETWORK_ERROR_MESSAGE, checkedAt: now };
    }

    let release: GithubRelease;
    try {
      release = (await response.json()) as GithubRelease;
    } catch {
      return { state: 'error', message: MALFORMED_ERROR_MESSAGE, checkedAt: now };
    }

    if (typeof release.tag_name !== 'string' || release.tag_name.length === 0) {
      return { state: 'error', message: MALFORMED_ERROR_MESSAGE, checkedAt: now };
    }

    const current = app.getVersion();
    const latest = release.tag_name.replace(/^v/i, '');

    if (compareVersions(latest, current) <= 0) {
      return { state: 'current', version: current, checkedAt: now };
    }

    return {
      state: 'available',
      current,
      latest,
      url: typeof release.html_url === 'string' ? release.html_url : RELEASES_PAGE_URL,
      downloadUrl: pickDmgUrl(release),
      notes: typeof release.body === 'string' ? release.body : '',
      publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
      checkedAt: now,
    };
  } catch (err) {
    saveState({ lastUpdateCheck: now });
    return { state: 'error', message: friendlyMessage(err), checkedAt: now };
  } finally {
    clearTimeout(timer);
  }
}
