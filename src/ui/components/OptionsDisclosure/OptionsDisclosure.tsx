'use client';

import type { ConverterOptions, FormatCategory, FormatDef } from '@core/types';
import { DisclosureIcon } from '../../icons';
import type { SaveLocation } from '../../types';
import { type ControlDescriptor, getCategoryControls } from '../../utils/optionsConfig';
import styles from './OptionsDisclosure.module.css';

interface OptionsDisclosureProps {
  readonly expanded: boolean;
  readonly disabled: boolean;
  readonly category: FormatCategory | null;
  readonly targetDef: FormatDef | undefined;
  readonly values: ConverterOptions;
  readonly saveLocation: SaveLocation;
  readonly onToggle: () => void;
  readonly onChange: (key: string, value: string | boolean) => void;
  readonly onChooseFolder: () => void;
  readonly onRevertSaveLocation: () => void;
}

function Control({
  descriptor,
  value,
  onChange,
}: {
  descriptor: ControlDescriptor;
  value: unknown;
  onChange: (v: string | boolean) => void;
}) {
  if (descriptor.kind === 'segmented') {
    return (
      <div className={styles.segmented} role="radiogroup" aria-label={descriptor.label}>
        {descriptor.choices.map((choice) => (
          <label
            key={choice.value}
            className={`${styles.segmentButton} ${value === choice.value ? styles.segmentActive : ''}`}
          >
            <input
              type="radio"
              className={styles.segmentInput}
              name={descriptor.key}
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
  if (descriptor.kind === 'select') {
    return (
      <select
        className={styles.select}
        value={value as string}
        aria-label={descriptor.label}
        onChange={(e) => onChange(e.target.value)}
      >
        {descriptor.choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!value}
      aria-label={descriptor.label}
      className={`${styles.switch} ${value ? styles.switchOn : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className={styles.switchKnob} />
    </button>
  );
}

export function OptionsDisclosure({
  expanded,
  disabled,
  category,
  targetDef,
  values,
  saveLocation,
  onToggle,
  onChange,
  onChooseFolder,
  onRevertSaveLocation,
}: OptionsDisclosureProps) {
  const controls = getCategoryControls(category, targetDef);

  return (
    <div className={disabled ? styles.disabledWrap : undefined}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={expanded}
        aria-controls="options-panel"
        data-testid="options-disclosure"
        onClick={onToggle}
      >
        <DisclosureIcon className={expanded ? styles.iconExpanded : undefined} />
        Options
      </button>
      <div className={`${styles.panel} ${expanded ? styles.panelExpanded : ''}`}>
        <div className={styles.panelInner}>
          <div id="options-panel" inert={!expanded} className={styles.rows}>
            {controls.map((descriptor) => (
              <div key={descriptor.key} className={styles.row}>
                <span className={styles.rowLabel}>{descriptor.label}</span>
                <Control
                  descriptor={descriptor}
                  value={values[descriptor.key]}
                  onChange={(v) => onChange(descriptor.key, v)}
                />
              </div>
            ))}
            <div className={styles.row}>
              <span className={styles.rowLabel}>Save to</span>
              {saveLocation.mode === 'same' ? (
                <button
                  type="button"
                  className={styles.saveButton}
                  onClick={onChooseFolder}
                >
                  Same folder as original
                </button>
              ) : (
                <span className={styles.saveChosen}>
                  <button
                    type="button"
                    className={styles.saveButton}
                    onClick={onChooseFolder}
                  >
                    {saveLocation.dir.split('/').filter(Boolean).pop() ??
                      saveLocation.dir}
                  </button>
                  <button
                    type="button"
                    className={styles.saveRevert}
                    aria-label="Use the original folder instead"
                    onClick={onRevertSaveLocation}
                  >
                    ×
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
