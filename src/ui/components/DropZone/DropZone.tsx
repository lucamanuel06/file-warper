'use client';

import type { DragEvent } from 'react';
import { DropGlyph } from '../../icons';
import styles from './DropZone.module.css';

interface DropZoneProps {
  readonly dragActive: boolean;
  readonly onClick: () => void;
  readonly onDragOver: (e: DragEvent) => void;
  readonly onDragLeave: (e: DragEvent) => void;
  readonly onDrop: (e: DragEvent) => void;
}

export function DropZone({
  dragActive,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
}: DropZoneProps) {
  return (
    <button
      type="button"
      data-testid="dropzone"
      className={`${styles.zone} ${dragActive ? styles.active : ''}`}
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <DropGlyph className={styles.glyph} />
      <span className={styles.headline}>Drop files here</span>
      <span className={styles.sub}>or click to browse</span>
    </button>
  );
}
