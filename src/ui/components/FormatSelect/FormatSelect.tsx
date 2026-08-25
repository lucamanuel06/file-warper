'use client';

import { ChevronDownIcon } from '../../icons';
import type { TargetGroup } from '../../utils/targetGroups';
import styles from './FormatSelect.module.css';

interface FormatSelectProps {
  readonly value: string | null;
  readonly groups: readonly TargetGroup[];
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}

export function FormatSelect({ value, groups, disabled, onChange }: FormatSelectProps) {
  return (
    <div className={styles.wrap}>
      <select
        className={styles.select}
        value={value ?? ''}
        disabled={disabled}
        aria-label="Convert to"
        data-testid="format-select"
        onChange={(e) => onChange(e.target.value)}
      >
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDownIcon className={styles.chevron} />
    </div>
  );
}
