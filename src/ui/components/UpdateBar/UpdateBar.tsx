'use client';

import type { UpdateDownloadProgress } from '@shared/ipc';
import { CloseIcon } from '../../icons';
import styles from './UpdateBar.module.css';

interface UpdateBarProps {
  readonly version: string;
  readonly download: UpdateDownloadProgress | null;
  readonly onDownload: () => void;
  readonly onCancel: () => void;
  readonly onReveal: (path: string) => void;
  readonly onDismiss: () => void;
}

/** `233281791` -> `222 MB`. Binary units, which is what Finder shows for a .dmg. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function progressLabel(download: UpdateDownloadProgress): string {
  if (download.total > 0) {
    return `${formatBytes(download.received)} of ${formatBytes(download.total)}`;
  }
  // No Content-Length: showing a percentage we do not have would be a lie.
  return `${formatBytes(download.received)} downloaded`;
}

export function UpdateBar({
  version,
  download,
  onDownload,
  onCancel,
  onReveal,
  onDismiss,
}: UpdateBarProps) {
  const state = download?.state;
  const donePath = download?.state === 'done' ? download.path : undefined;

  return (
    <div className={styles.bar} data-testid="update-bar" data-state={state ?? 'idle'}>
      {state === 'downloading' && download ? (
        <>
          <span className={styles.message}>Downloading File Warper {version}</span>
          <span className={styles.detail}>{progressLabel(download)}</span>
          {/* An unknown total renders as an indeterminate bar rather than 0%. */}
          <div
            className={styles.track}
            role="progressbar"
            aria-label={`Downloading File Warper ${version}`}
            {...(download.ratio >= 0
              ? {
                  'aria-valuenow': Math.round(download.ratio * 100),
                  'aria-valuemin': 0,
                  'aria-valuemax': 100,
                }
              : {})}
          >
            <div
              className={download.ratio >= 0 ? styles.fill : styles.fillIndeterminate}
              style={
                download.ratio >= 0 ? { width: `${download.ratio * 100}%` } : undefined
              }
            />
          </div>
          <button type="button" className={styles.action} onClick={onCancel}>
            Cancel
          </button>
        </>
      ) : donePath ? (
        <>
          <span className={styles.message}>
            File Warper {version} downloaded — quit the app, then open it to install.
          </span>
          <button
            type="button"
            className={styles.action}
            onClick={() => onReveal(donePath)}
          >
            Reveal in Finder
          </button>
        </>
      ) : state === 'error' ? (
        <>
          <span className={styles.message}>
            {download?.message ?? "The download didn't finish."}
          </span>
          <button type="button" className={styles.action} onClick={onDownload}>
            Try again
          </button>
        </>
      ) : (
        <>
          <span className={styles.message}>File Warper {version} is available</span>
          <button type="button" className={styles.action} onClick={onDownload}>
            Download
          </button>
        </>
      )}
      <button
        type="button"
        className={styles.dismiss}
        aria-label="Dismiss update notice"
        onClick={onDismiss}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
