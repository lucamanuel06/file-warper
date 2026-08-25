import type {
  ConverterOptions,
  FormatCategory,
  FormatId,
  JobId,
  JobState,
  SerializedError,
} from '@core/types';

export type Phase = 'empty' | 'staged' | 'converting' | 'done';

/** Local job lifecycle: 'idle' before the file has ever been enqueued. */
export type RowState = JobState | 'idle';

export interface StagedFile {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly sourceFormat: FormatId | null;
  readonly category: FormatCategory | null;
  /** Pre-conversion preview only: can this file reach the current target? */
  reachable: boolean;
  jobId?: JobId;
  state: RowState;
  outputPath?: string;
  outputFormat?: FormatId;
  error?: SerializedError;
  expanded?: boolean;
}

export type SaveLocation =
  | { readonly mode: 'same' }
  | { readonly mode: 'folder'; readonly dir: string };

export interface EnvironmentIssue {
  readonly message: string;
  readonly actionLabel: string;
  readonly action: () => void;
}

export type CategoryOptionValues = Partial<Record<FormatCategory, ConverterOptions>>;
