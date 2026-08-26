/**
 * FROZEN CONTRACT — persisted app settings.
 *
 * TYPES AND CONSTANTS ONLY (this file is compiled into the renderer bundle).
 *
 * Stored by main at `{userData}/settings.json`. Everything here is a genuine
 * user choice; anything the app can decide correctly on its own does NOT
 * belong in this file. Conversion knobs that change per job (quality,
 * resolution, channels) stay in the Options disclosure, not in Settings.
 */

import type { CollisionPolicy } from '../core/types';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface AppSettings {
  /** Overrides the OS appearance. 'system' follows it. */
  readonly theme: ThemePreference;

  /** Where converted files land. 'fixed' uses `outputDir`. */
  readonly outputMode: 'alongside' | 'fixed';
  /** Absolute path; only meaningful when `outputMode` is 'fixed'. */
  readonly outputDir: string | null;

  /** What to do when the destination filename is taken. */
  readonly collision: CollisionPolicy;

  /** Carry EXIF / ID3 / XMP across when the target format supports it. */
  readonly preserveMetadata: boolean;

  /** Open Finder at the output as soon as a batch finishes. */
  readonly revealWhenDone: boolean;

  /**
   * Ask GitHub whether a newer release exists, at most once every 24h.
   *
   * This is the ONLY network request File Warper ever makes. It sends nothing
   * but the standard HTTP request to the public releases endpoint — no file
   * names, no usage data, no identifiers. Turn it off and the app is fully
   * offline again.
   */
  readonly checkForUpdates: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  outputMode: 'alongside',
  outputDir: null,
  collision: 'suffix',
  preserveMetadata: true,
  revealWhenDone: false,
  checkForUpdates: true,
};

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export type UpdateStatus =
  /** Never checked, or checking is disabled in settings. */
  | { readonly state: 'idle' }
  | { readonly state: 'checking' }
  | { readonly state: 'current'; readonly version: string; readonly checkedAt: number }
  | {
      readonly state: 'available';
      readonly current: string;
      readonly latest: string;
      /** The release page — where the user goes to download. */
      readonly url: string;
      /** Direct .dmg asset URL when the release has one. */
      readonly downloadUrl: string | null;
      /** Release notes body, markdown. May be long; the UI truncates. */
      readonly notes: string;
      readonly publishedAt: string;
      readonly checkedAt: number;
    }
  | { readonly state: 'error'; readonly message: string; readonly checkedAt: number };

/**
 * NOTE FOR IMPLEMENTERS — there is no silent auto-update, deliberately.
 *
 * macOS auto-update (Squirrel.Mac, which electron-updater drives) requires the
 * app to be signed with a Developer ID AND notarized. File Warper is ad-hoc
 * signed, so an in-place update would fail at the signature check and could
 * leave a broken bundle behind. We therefore *notify* and hand the user the
 * download, which always works. Revisit if the app ever gets a paid signing
 * identity.
 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const RELEASES_API_URL =
  'https://api.github.com/repos/lucamanuel06/file-warper/releases/latest';
export const RELEASES_PAGE_URL =
  'https://github.com/lucamanuel06/file-warper/releases/latest';
