import type { Ref } from 'react';
import { GearIcon } from '../../icons';
import styles from './TitleBar.module.css';

interface TitleBarProps {
  readonly ref?: Ref<HTMLButtonElement>;
  readonly onOpenSettings: () => void;
}

export function TitleBar({ ref, onOpenSettings }: TitleBarProps) {
  return (
    <div className={styles.titlebar} data-testid="titlebar">
      <span className={styles.title}>File Warper</span>
      <button
        ref={ref}
        type="button"
        className={styles.settingsButton}
        aria-label="Settings"
        data-testid="settings-button"
        onClick={onOpenSettings}
      >
        <GearIcon />
      </button>
    </div>
  );
}
