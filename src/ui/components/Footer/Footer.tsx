'use client';

import type { Phase } from '../../types';
import type { TargetGroup } from '../../utils/targetGroups';
import { FormatSelect } from '../FormatSelect/FormatSelect';
import styles from './Footer.module.css';

interface FooterProps {
  readonly phase: Extract<Phase, 'staged' | 'converting' | 'done'>;
  readonly target: string | null;
  readonly targetGroups: readonly TargetGroup[];
  readonly onTargetChange: (v: string) => void;
  readonly willConvertCount: number;
  readonly totalCount: number;
  readonly statusText: string;
  readonly overallProgress: number;
  readonly hasFailed: boolean;
  readonly onConvert: () => void;
  readonly onCancel: () => void;
  readonly onDone: () => void;
  readonly onRevealAll: () => void;
  readonly onRetryFailed: () => void;
}

export function Footer({
  phase,
  target,
  targetGroups,
  onTargetChange,
  willConvertCount,
  totalCount,
  statusText,
  overallProgress,
  hasFailed,
  onConvert,
  onCancel,
  onDone,
  onRevealAll,
  onRetryFailed,
}: FooterProps) {
  const staged = phase === 'staged';

  return (
    <div className={styles.footer} data-testid="footer">
      {phase === 'converting' && (
        <div
          className={styles.progressBar}
          role="progressbar"
          aria-valuenow={Math.round(overallProgress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ width: `${Math.round(overallProgress * 100)}%` }}
        />
      )}

      <div className={styles.left}>
        <span className={styles.label} aria-live="polite" data-testid="status-text">
          {staged ? 'Convert to' : statusText}
        </span>
        <FormatSelect
          value={target}
          groups={targetGroups}
          disabled={!staged}
          onChange={onTargetChange}
        />
      </div>

      <div className={styles.actions}>
        {staged && (
          <button
            type="button"
            className={styles.primaryButton}
            disabled={willConvertCount === 0}
            data-testid="convert-button"
            onClick={onConvert}
          >
            {willConvertCount === totalCount ? 'Convert' : `Convert ${willConvertCount}`}
          </button>
        )}
        {phase === 'converting' && (
          <button type="button" className={styles.secondaryButton} onClick={onCancel}>
            Cancel
          </button>
        )}
        {phase === 'done' && (
          <>
            {hasFailed && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onRetryFailed}
              >
                Retry failed
              </button>
            )}
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onRevealAll}
            >
              Reveal in Finder
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              data-testid="done-button"
              onClick={onDone}
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
