'use client';

import type { CollisionPolicy } from '@core/types';
import type { AppSettings, ThemePreference, UpdateStatus } from '@shared/settings';
import { useEffect, useRef } from 'react';
import { REPO_URL } from '../../useSettings';
import { Segmented, SelectField, Switch } from '../Controls/Controls';
import styles from './SettingsSheet.module.css';

const THEME_CHOICES: readonly { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const COLLISION_CHOICES: readonly { value: CollisionPolicy; label: string }[] = [
  { value: 'suffix', label: 'Add a number' },
  { value: 'overwrite', label: 'Overwrite' },
  { value: 'skip', label: 'Skip' },
];

function updateStatusLabel(status: UpdateStatus): string | null {
  switch (status.state) {
    case 'checking':
      return 'Checking…';
    case 'current':
      return "You're up to date";
    case 'available':
      return `Version ${status.latest} is available`;
    case 'error':
      return "Couldn't check for updates";
    default:
      return null;
  }
}

interface SettingsSheetProps {
  readonly open: boolean;
  readonly settings: AppSettings;
  readonly appVersion: string;
  readonly updateStatus: UpdateStatus;
  readonly onPatch: (patch: Partial<AppSettings>) => void;
  readonly onClose: () => void;
  readonly onChooseFolder: () => void;
  readonly onClearFolder: () => void;
  readonly onCheckNow: () => void;
  readonly onOpenLink: (url: string) => void;
}

export function SettingsSheet({
  open,
  settings,
  appVersion,
  updateStatus,
  onPatch,
  onClose,
  onChooseFolder,
  onClearFolder,
  onCheckNow,
  onOpenLink,
}: SettingsSheetProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const statusLabel = updateStatusLabel(updateStatus);
  const showDownload = updateStatus.state === 'available';
  const showChecking = updateStatus.state === 'checking';
  const downloadUrl =
    updateStatus.state === 'available'
      ? (updateStatus.downloadUrl ?? updateStatus.url)
      : null;

  return (
    <>
      <button
        type="button"
        className={`${styles.backdrop} ${open ? styles.backdropOpen : ''}`}
        aria-hidden="true"
        tabIndex={-1}
        data-testid="settings-backdrop"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className={`${styles.sheet} ${open ? styles.sheetOpen : ''}`}
        data-testid="settings-sheet"
      >
        <h2 className={styles.title}>Settings</h2>

        <section className={styles.section}>
          <h3 className={styles.sectionLabel}>Appearance</h3>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Theme</span>
            <Segmented
              name="theme"
              label="Theme"
              value={settings.theme}
              choices={THEME_CHOICES}
              testId="theme-control"
              onChange={(theme) => onPatch({ theme })}
            />
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionLabel}>Files</h3>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Save converted files</span>
            {settings.outputMode === 'alongside' ? (
              <button
                type="button"
                className={styles.pillButton}
                onClick={onChooseFolder}
              >
                Same folder as original
              </button>
            ) : (
              <span className={styles.pillGroup}>
                <button
                  type="button"
                  className={styles.pillButton}
                  onClick={onChooseFolder}
                >
                  {settings.outputDir?.split('/').filter(Boolean).pop() ??
                    settings.outputDir}
                </button>
                <button
                  type="button"
                  className={styles.pillRevert}
                  aria-label="Use the original folder instead"
                  onClick={onClearFolder}
                >
                  ×
                </button>
              </span>
            )}
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>If the file already exists</span>
            <SelectField
              label="If the file already exists"
              value={settings.collision}
              choices={COLLISION_CHOICES}
              testId="collision-select"
              onChange={(collision) => onPatch({ collision })}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>
              Keep metadata
              <span className={styles.subLabel}>
                EXIF, ID3 tags and similar, where the format supports it.
              </span>
            </span>
            <Switch
              label="Keep metadata"
              checked={settings.preserveMetadata}
              testId="preserve-metadata-toggle"
              onChange={(preserveMetadata) => onPatch({ preserveMetadata })}
            />
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionLabel}>When finished</h3>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Reveal in Finder</span>
            <Switch
              label="Reveal in Finder"
              checked={settings.revealWhenDone}
              testId="reveal-when-done-toggle"
              onChange={(revealWhenDone) => onPatch({ revealWhenDone })}
            />
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionLabel}>Updates</h3>
          <div className={styles.row}>
            <span className={styles.rowLabel}>
              Check for updates automatically
              <span className={styles.subLabel}>
                The only time File Warper uses the internet. It sends nothing about you or
                your files.
              </span>
            </span>
            <Switch
              label="Check for updates automatically"
              checked={settings.checkForUpdates}
              testId="check-for-updates-toggle"
              onChange={(checkForUpdates) => onPatch({ checkForUpdates })}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel} aria-live="polite">
              {statusLabel ?? `Version ${appVersion}`}
            </span>
            {showDownload && downloadUrl ? (
              <button
                type="button"
                className={styles.pillButton}
                onClick={() => onOpenLink(downloadUrl)}
              >
                Download
              </button>
            ) : (
              !showChecking && (
                <button type="button" className={styles.pillButton} onClick={onCheckNow}>
                  Check now
                </button>
              )
            )}
          </div>
        </section>

        <div className={styles.footer}>
          <span>File Warper {appVersion}</span>
          <button
            type="button"
            className={styles.footerLink}
            onClick={() => onOpenLink(REPO_URL)}
          >
            GitHub
          </button>
        </div>
      </div>
    </>
  );
}
