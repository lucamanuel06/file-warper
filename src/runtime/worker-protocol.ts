/**
 * The main <-> utilityProcess worker message protocol. This is an internal
 * implementation detail of the runtime — unrelated to (and not constrained
 * by) the frozen `src/shared/ipc.ts`, which governs main <-> renderer only.
 */

import type { ConversionErrorCode } from '@core/types';

export interface WireInput {
  readonly path: string;
  readonly format: string;
  readonly size: number;
}

export interface WireOutput {
  readonly path: string;
  readonly format: string;
}

export interface RunHopMessage {
  readonly type: 'run';
  readonly taskId: string;
  readonly converterId: string;
  readonly input: WireInput;
  readonly output: WireOutput;
  readonly options: Record<string, unknown>;
  readonly scratchDir: string;
}

export interface CancelTaskMessage {
  readonly type: 'cancel';
  readonly taskId: string;
}

export type MainToWorkerMessage = RunHopMessage | CancelTaskMessage;

export interface ReadyMessage {
  readonly type: 'ready';
}

export interface ProgressMessage {
  readonly type: 'progress';
  readonly taskId: string;
  readonly ratio: number;
  readonly message?: string;
}

export interface DoneMessage {
  readonly type: 'done';
  readonly taskId: string;
  readonly bytes?: number;
  readonly warnings?: string[];
  readonly meta?: Record<string, unknown>;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly taskId: string;
  readonly code: ConversionErrorCode;
  readonly userMessage: string;
  readonly detail?: string;
  readonly retryable: boolean;
}

export interface CancelledMessage {
  readonly type: 'cancelled';
  readonly taskId: string;
}

export type WorkerToMainMessage =
  | ReadyMessage
  | ProgressMessage
  | DoneMessage
  | ErrorMessage
  | CancelledMessage;
