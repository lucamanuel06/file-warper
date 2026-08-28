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

/**
 * Installer extensions this platform can actually run, best first.
 *
 * macOS: the .dmg is what a person expects to double-click; the -mac.zip is
 * the same bundle for scripted installs, so it is only a fallback.
 * Linux: AppImage before .deb — AppImage runs on any distro, .deb does not.
 */
const PLATFORM_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  darwin: ['.dmg', '.zip'],
  win32: ['.exe', '.msi'],
  linux: ['.appimage', '.deb', '.rpm'],
};

/**
 * Every spelling of an architecture that appears in a release filename.
 * electron-builder is not consistent about it: the same build produces
 * `-arm64.dmg`, `-x86_64.AppImage` and `_amd64.deb`.
 */
const ARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  arm64: ['arm64', 'aarch64'],
  x64: ['x64', 'x86_64', 'amd64', 'intel'],
  ia32: ['ia32', 'i386', 'i686', 'x86'],
  arm: ['armv7l', 'armhf'],
};

/** Whole-token match: `mac` hits `-mac.zip` but not `macarena.zip`. */
function namesToken(name: string, token: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, 'i').test(name);
}

const ALL_ALIASES = Object.entries(ARCH_ALIASES).flatMap(([arch, aliases]) =>
  aliases.map((alias) => ({ arch, alias })),
);

/**
 * Which architectures a filename actually claims.
 *
 * The overlap filter is the subtle part: `x86` is a token inside `x86_64`, so
 * a plain per-alias scan reads every Intel build as 32-bit as well. Only the
 * most specific alias present is allowed to count.
 */
function archesNamed(name: string): Set<string> {
  const hits = ALL_ALIASES.filter(({ alias }) => namesToken(name, alias));
  return new Set(
    hits
      .filter((h) => !hits.some((o) => o.alias !== h.alias && o.alias.includes(h.alias)))
      .map((h) => h.arch),
  );
}

function namesArch(name: string, arch: string): boolean {
  return archesNamed(name).has(arch);
}

/** True when the filename claims an architecture that is NOT ours. */
function namesForeignArch(name: string, arch: string): boolean {
  const named = archesNamed(name);
  return named.size > 0 && !named.has(arch);
}

interface Candidate {
  readonly url: string;
  readonly extRank: number;
  readonly archRank: number;
  readonly variantRank: number;
}

/**
 * Picks the asset that belongs to the machine we are running on.
 *
 * This used to be `pickDmgUrl`, which returned the first `.dmg` in the release
 * regardless of anything: Windows and Linux users were handed a macOS disk
 * image, and an Intel Mac got whichever of the two Mac builds GitHub happened
 * to list first. A release now carries eight assets across three platforms and
 * two architectures, so guessing is not survivable.
 *
 * Returns null rather than a near-miss when nothing matches — the caller falls
 * back to the release page, where the user can see all the options. Handing
 * someone a binary their machine cannot execute is worse than one extra click.
 */
export function pickAssetUrl(
  release: GithubRelease,
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (!Array.isArray(release.assets)) return null;
  const extensions = PLATFORM_EXTENSIONS[platform];
  if (!extensions) return null;

  const candidates: Candidate[] = [];

  for (const asset of release.assets as GithubAsset[]) {
    const name = typeof asset?.name === 'string' ? asset.name : '';
    const url =
      typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : '';
    if (!name || !url) continue;

    const lower = name.toLowerCase();
    const extRank = extensions.findIndex((ext) => lower.endsWith(ext));
    if (extRank < 0) continue;

    // A .zip is only ours if it says so. electron-builder ships `-mac.zip`;
    // on Windows or Linux a bare .zip in the release is something else.
    if (lower.endsWith('.zip') && !namesToken(lower, 'mac')) continue;

    // Never offer a build for another architecture. An arm64 installer simply
    // will not run on an Intel machine.
    if (namesForeignArch(lower, arch)) continue;

    candidates.push({
      url,
      extRank,
      // An asset that names our arch beats one that names none. The unnamed
      // one is still valid — the Intel Mac build is just `File.Warper-x.y.z.dmg`.
      archRank: namesArch(lower, arch) ? 0 : 1,
      // Prefer the installer over the portable build: someone updating an app
      // they already installed wants the thing that replaces it.
      variantRank: namesToken(lower, 'portable') ? 1 : 0,
    });
  }

  candidates.sort(
    (a, b) =>
      a.extRank - b.extRank || a.archRank - b.archRank || a.variantRank - b.variantRank,
  );
  return candidates[0]?.url ?? null;
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
      downloadUrl: pickAssetUrl(release),
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
