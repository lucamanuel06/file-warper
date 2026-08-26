'use client';

import { CloseIcon } from '../../icons';
import styles from './UpdateBar.module.css';

interface UpdateBarProps {
  readonly version: string;
  readonly onDownload: () => void;
  readonly onDismiss: () => void;
}

export function UpdateBar({ version, onDownload, onDismiss }: UpdateBarProps) {
  return (
    <div className={styles.bar} data-testid="update-bar">
      <span className={styles.message}>File Warper {version} is available</span>
      <button type="button" className={styles.download} onClick={onDownload}>
        Download
      </button>
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
