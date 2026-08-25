'use client';

import type { DragEvent } from 'react';
import type { Phase, StagedFile } from '../../types';
import styles from './FileList.module.css';
import { FileRow } from './FileRow';

interface FileListProps {
  readonly files: readonly StagedFile[];
  readonly phase: Extract<Phase, 'staged' | 'converting' | 'done'>;
  readonly willConvertCount: number;
  readonly dragActive: boolean;
  readonly onClear: () => void;
  readonly onRemove: (id: string) => void;
  readonly onReveal: (path: string) => void;
  readonly onToggleExpand: (id: string) => void;
  readonly onCopyDetails: (detail: string) => void;
  readonly onDragOver: (e: DragEvent) => void;
  readonly onDragLeave: (e: DragEvent) => void;
  readonly onDrop: (e: DragEvent) => void;
}

export function FileList({
  files,
  phase,
  willConvertCount,
  dragActive,
  onClear,
  onRemove,
  onReveal,
  onToggleExpand,
  onCopyDetails,
  onDragOver,
  onDragLeave,
  onDrop,
}: FileListProps) {
  return (
    <section
      className={`${styles.wrap} ${dragActive ? styles.dragRing : ''}`}
      aria-label="Staged files"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="file-list"
    >
      {phase === 'staged' && (
        <div className={styles.header} data-testid="list-header">
          <span className={styles.headerCount}>
            {files.length} file{files.length === 1 ? '' : 's'} · {willConvertCount} will
            convert
          </span>
          <button type="button" className={styles.clearButton} onClick={onClear}>
            Clear
          </button>
        </div>
      )}
      {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none strips list semantics in Safari/VoiceOver; role="list" restores it */}
      <ul role="list" className={styles.list}>
        {files.map((file, index) => (
          <FileRow
            key={file.id}
            file={file}
            phase={phase}
            index={index}
            onRemove={onRemove}
            onReveal={onReveal}
            onToggleExpand={onToggleExpand}
            onCopyDetails={onCopyDetails}
          />
        ))}
      </ul>
    </section>
  );
}
