'use client';

import { getFormat } from '@core/formats';
import { CheckIcon, CloseIcon } from '../../icons';
import type { Phase, StagedFile } from '../../types';
import { formatBytes, middleTruncate, shortFormatLabel } from '../../utils/format';
import styles from './FileList.module.css';

interface FileRowProps {
  readonly file: StagedFile;
  readonly phase: Extract<Phase, 'staged' | 'converting' | 'done'>;
  readonly index: number;
  readonly onRemove: (id: string) => void;
  readonly onReveal: (path: string) => void;
  readonly onToggleExpand: (id: string) => void;
  readonly onCopyDetails: (detail: string) => void;
}

export function FileRow({
  file,
  phase,
  index,
  onRemove,
  onReveal,
  onToggleExpand,
  onCopyDetails,
}: FileRowProps) {
  const sourceDef = file.sourceFormat ? getFormat(file.sourceFormat) : undefined;
  const outputDef = file.outputFormat ? getFormat(file.outputFormat) : undefined;
  const chipDef = file.state === 'succeeded' && outputDef ? outputDef : sourceDef;

  const isDimStaged = phase === 'staged' && !file.reachable;
  const isDimResult = file.state === 'skipped' || file.state === 'cancelled';
  const isFailed = file.state === 'failed';
  const isQueued = file.state === 'queued' || file.state === 'routing';
  const inBatch = phase === 'converting' && file.state !== 'skipped';

  const rowClasses = [
    styles.row,
    isDimStaged || isDimResult ? styles.dim : '',
    isFailed ? styles.rowFailed : '',
    inBatch ? styles.inBatch : '',
    phase === 'done' ? styles.doneEnter : '',
  ]
    .filter(Boolean)
    .join(' ');

  const nameClass = `${styles.name} ${isQueued ? styles.nameQueued : ''}`.trim();

  let meta: React.ReactNode;
  if (isDimStaged || file.state === 'skipped') {
    meta = <span className={styles.metaLabel}>Skipped</span>;
  } else if (file.state === 'cancelled') {
    meta = <span className={styles.metaLabel}>Cancelled</span>;
  } else if (isFailed) {
    meta = <span className={styles.metaLabelDanger}>Failed</span>;
  } else if (file.state === 'succeeded') {
    meta = <CheckIcon className={styles.checkIcon} />;
  } else {
    meta = <span className={styles.metaLabel}>{formatBytes(file.size)}</span>;
  }

  let trailing: React.ReactNode = null;
  if (phase === 'staged') {
    trailing = (
      <button
        type="button"
        className={styles.removeButton}
        aria-label={`Remove ${file.name}`}
        onClick={() => onRemove(file.id)}
      >
        <CloseIcon />
      </button>
    );
  } else if (phase === 'done' && file.state === 'succeeded' && file.outputPath) {
    const outputPath = file.outputPath;
    trailing = (
      <button
        type="button"
        className={styles.revealButton}
        aria-label={`Reveal ${file.name} in Finder`}
        onClick={() => onReveal(outputPath)}
      >
        ↗
      </button>
    );
  }

  const body = (
    <>
      <span className={styles.chip}>{chipDef ? shortFormatLabel(chipDef) : '—'}</span>
      <span className={nameClass} title={file.name}>
        {middleTruncate(file.name)}
      </span>
      <span className={styles.metaSlot}>{meta}</span>
      {trailing}
    </>
  );

  const style =
    phase === 'done' ? { animationDelay: `${Math.min(index, 15) * 20}ms` } : undefined;

  if (isFailed) {
    return (
      <li
        className={rowClasses}
        style={style}
        data-testid="file-row"
        data-state={file.state}
      >
        <button
          type="button"
          className={`${styles.rowInner} ${styles.rowButton}`}
          aria-expanded={!!file.expanded}
          aria-controls={`error-${file.id}`}
          onClick={() => onToggleExpand(file.id)}
        >
          {body}
        </button>
        {file.expanded && (
          <div id={`error-${file.id}`} className={styles.errorDetail}>
            <p className={styles.errorText}>
              {(file.error?.detail ?? file.error?.userMessage ?? 'Unknown error').slice(
                0,
                200,
              )}
            </p>
            <button
              type="button"
              className={styles.copyButton}
              onClick={() =>
                onCopyDetails(
                  file.error?.detail ?? file.error?.userMessage ?? 'Unknown error',
                )
              }
            >
              Copy details
            </button>
          </div>
        )}
      </li>
    );
  }

  return (
    <li
      className={`${rowClasses} ${styles.rowInner}`}
      style={style}
      data-testid="file-row"
      data-state={file.state}
    >
      {body}
    </li>
  );
}
