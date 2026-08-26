'use client';

import styles from './Controls.module.css';

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface SegmentedProps<T extends string> {
  readonly name: string;
  readonly label: string;
  readonly value: T;
  readonly choices: readonly Choice<T>[];
  readonly onChange: (value: T) => void;
  readonly testId?: string;
}

/** A segmented radio group, styled to match the Options disclosure. */
export function Segmented<T extends string>({
  name,
  label,
  value,
  choices,
  onChange,
  testId,
}: SegmentedProps<T>) {
  return (
    <div
      className={styles.segmented}
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
    >
      {choices.map((choice) => (
        <label
          key={choice.value}
          className={`${styles.segmentButton} ${value === choice.value ? styles.segmentActive : ''}`}
        >
          <input
            type="radio"
            className={styles.segmentInput}
            name={name}
            value={choice.value}
            checked={value === choice.value}
            onChange={() => onChange(choice.value)}
          />
          <span>{choice.label}</span>
        </label>
      ))}
    </div>
  );
}

interface SwitchProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly testId?: string;
}

/** A real switch control: `role="switch"` on a button, per the a11y contract. */
export function Switch({ label, checked, onChange, testId }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.switchKnob} />
    </button>
  );
}

interface SelectFieldProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly choices: readonly Choice<T>[];
  readonly onChange: (value: T) => void;
  readonly testId?: string;
}

/** A native select, styled to match the Options disclosure's `.select`. */
export function SelectField<T extends string>({
  label,
  value,
  choices,
  onChange,
  testId,
}: SelectFieldProps<T>) {
  return (
    <select
      className={styles.select}
      value={value}
      aria-label={label}
      data-testid={testId}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}
