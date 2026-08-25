import type { ConverterOptions, FormatCategory, FormatDef } from '@core/types';

export type ControlDescriptor =
  | {
      key: string;
      kind: 'segmented';
      label: string;
      choices: readonly { value: string; label: string }[];
    }
  | {
      key: string;
      kind: 'select';
      label: string;
      choices: readonly { value: string; label: string }[];
    }
  | { key: string; kind: 'toggle'; label: string };

const QUALITY_DEFAULT = { quality: 'balanced' };

const CATEGORY_DEFAULTS: Partial<Record<FormatCategory, ConverterOptions>> = {
  image: { ...QUALITY_DEFAULT, maxSize: 'original' },
  audio: { ...QUALITY_DEFAULT, channels: 'keep' },
  video: { ...QUALITY_DEFAULT, resolution: 'original' },
  document: { pageSize: 'auto' },
  data: { flatten: false },
};

export function defaultOptionsFor(category: FormatCategory | null): ConverterOptions {
  return category ? (CATEGORY_DEFAULTS[category] ?? {}) : {};
}

/** At most two contextual controls per category; "Save to" (universal) is handled separately. */
export function getCategoryControls(
  category: FormatCategory | null,
  targetDef: FormatDef | undefined,
): ControlDescriptor[] {
  switch (category) {
    case 'image':
      return [
        ...(targetDef?.lossy
          ? ([
              {
                key: 'quality',
                kind: 'segmented',
                label: 'Quality',
                choices: [
                  { value: 'smaller', label: 'Smaller' },
                  { value: 'balanced', label: 'Balanced' },
                  { value: 'best', label: 'Best' },
                ],
              },
            ] as const)
          : []),
        {
          key: 'maxSize',
          kind: 'select',
          label: 'Max size',
          choices: [
            { value: 'original', label: 'Original' },
            { value: '4000', label: '4000 px' },
            { value: '2000', label: '2000 px' },
            { value: '1000', label: '1000 px' },
          ],
        },
      ];
    case 'audio':
      return [
        ...(targetDef?.lossy
          ? ([
              {
                key: 'quality',
                kind: 'segmented',
                label: 'Quality',
                choices: [
                  { value: 'small', label: 'Small' },
                  { value: 'balanced', label: 'Balanced' },
                  { value: 'best', label: 'Best' },
                ],
              },
            ] as const)
          : []),
        {
          key: 'channels',
          kind: 'select',
          label: 'Channels',
          choices: [
            { value: 'keep', label: 'Keep' },
            { value: 'mono', label: 'Mono' },
          ],
        },
      ];
    case 'video':
      return [
        {
          key: 'quality',
          kind: 'segmented',
          label: 'Quality',
          choices: [
            { value: 'smaller', label: 'Smaller' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'best', label: 'Best' },
          ],
        },
        {
          key: 'resolution',
          kind: 'select',
          label: 'Resolution',
          choices: [
            { value: 'original', label: 'Original' },
            { value: '1080p', label: '1080p' },
            { value: '720p', label: '720p' },
            { value: '480p', label: '480p' },
          ],
        },
      ];
    case 'document':
      return targetDef?.id === 'pdf'
        ? [
            {
              key: 'pageSize',
              kind: 'select',
              label: 'Page size',
              choices: [
                { value: 'auto', label: 'Auto' },
                { value: 'a4', label: 'A4' },
                { value: 'letter', label: 'Letter' },
              ],
            },
          ]
        : [];
    case 'data':
      return [{ key: 'flatten', kind: 'toggle', label: 'Flatten nested keys' }];
    default:
      return [];
  }
}
