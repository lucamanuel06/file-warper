/**
 * Persisted settings store. Reads/writes `{userData}/settings.json`.
 *
 * Every field is validated on both `load()` and `patch()` — a settings file
 * edited by hand (or corrupted) must never crash the app or produce an
 * invalid conversion request. Unknown keys are dropped; wrong types fall
 * back to `DEFAULT_SETTINGS`.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { CollisionPolicy } from '@core/types';
import type { AppSettings, ThemePreference } from '@shared/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { app } from 'electron';

const THEME_VALUES: readonly ThemePreference[] = ['system', 'light', 'dark'];
const COLLISION_VALUES: readonly CollisionPolicy[] = [
  'suffix',
  'overwrite',
  'skip',
  'timestamp',
];

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function isValidOutputDir(dir: unknown): dir is string {
  if (typeof dir !== 'string' || dir.length === 0) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Merges `raw` over `DEFAULT_SETTINGS`, dropping/replacing anything invalid. */
function sanitize(raw: unknown): AppSettings {
  const src: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const theme: ThemePreference =
    typeof src.theme === 'string' && (THEME_VALUES as string[]).includes(src.theme)
      ? (src.theme as ThemePreference)
      : DEFAULT_SETTINGS.theme;

  const collision: CollisionPolicy =
    typeof src.collision === 'string' &&
    (COLLISION_VALUES as string[]).includes(src.collision)
      ? (src.collision as CollisionPolicy)
      : DEFAULT_SETTINGS.collision;

  const preserveMetadata =
    typeof src.preserveMetadata === 'boolean'
      ? src.preserveMetadata
      : DEFAULT_SETTINGS.preserveMetadata;

  const revealWhenDone =
    typeof src.revealWhenDone === 'boolean'
      ? src.revealWhenDone
      : DEFAULT_SETTINGS.revealWhenDone;

  const checkForUpdates =
    typeof src.checkForUpdates === 'boolean'
      ? src.checkForUpdates
      : DEFAULT_SETTINGS.checkForUpdates;

  let outputMode: AppSettings['outputMode'] =
    src.outputMode === 'alongside' || src.outputMode === 'fixed'
      ? src.outputMode
      : DEFAULT_SETTINGS.outputMode;

  // `outputDir` must be a real, existing directory or the pairing is invalid
  // and both fields fall back together — a stale/hand-edited path must never
  // become a silently-broken 'fixed' output mode.
  const outputDir: string | null = isValidOutputDir(src.outputDir) ? src.outputDir : null;
  if (outputDir === null) outputMode = 'alongside';

  return {
    theme,
    outputMode,
    outputDir,
    collision,
    preserveMetadata,
    revealWhenDone,
    checkForUpdates,
  };
}

function persist(settings: AppSettings): void {
  const target = settingsPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmpPath = `${target}.${process.pid}-${Math.floor(Math.random() * 1e9)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
    fs.renameSync(tmpPath, target);
  } catch (err) {
    // Best-effort — a failed write to a settings file is not fatal; the
    // in-memory `current` value is still correct for the rest of this run.
    console.error('[settings] failed to persist settings.json', err);
  }
}

let current: AppSettings = { ...DEFAULT_SETTINGS };
const emitter = new EventEmitter();

/** Reads the settings file, validates it, and caches the result. */
export function load(): AppSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    current = sanitize(JSON.parse(raw));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.error('[settings] settings.json unreadable, falling back to defaults', err);
    }
    current = sanitize({});
  }
  return current;
}

export function get(): AppSettings {
  return current;
}

/** Merges `partial`, validates, persists atomically, and returns the full result. */
export function patch(partial: Partial<AppSettings>): AppSettings {
  current = sanitize({ ...current, ...partial });
  persist(current);
  emitter.emit('change', current);
  return current;
}

/** Subscribe to settings changes (e.g. to keep `nativeTheme` in sync). Returns a disposer. */
export function onChange(listener: (settings: AppSettings) => void): () => void {
  emitter.on('change', listener);
  return () => emitter.off('change', listener);
}
