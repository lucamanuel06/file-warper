'use client';

import { WarningIcon } from '../../icons';
import type { EnvironmentIssue } from '../../types';
import styles from './ErrorBanner.module.css';

interface ErrorBannerProps {
  readonly issue: EnvironmentIssue;
}

export function ErrorBanner({ issue }: ErrorBannerProps) {
  return (
    <div className={styles.banner} role="alert" data-testid="environment-banner">
      <WarningIcon className={styles.icon} />
      <span className={styles.message}>{issue.message}</span>
      <button type="button" className={styles.action} onClick={issue.action}>
        {issue.actionLabel}
      </button>
    </div>
  );
}
