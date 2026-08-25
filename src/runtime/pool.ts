/**
 * The utilityProcess worker pool. Each worker runs one hop at a time; a
 * native crash or OOM kills that process only — main detects the `exit` and
 * respawns. This is why we use `utilityProcess`, not `worker_threads` (see
 * docs/spec-core-architecture.md §4).
 */

import os from 'node:os';
import path from 'node:path';
import type { ConversionErrorCode } from '@core/types';
import { utilityProcess } from 'electron';
import type { RunHopMessage, WorkerToMainMessage } from './worker-protocol';

const CANCEL_ACK_TIMEOUT_MS = 5000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function defaultPoolSize(): number {
  return clamp(os.cpus().length - 1, 1, 4);
}

export interface HopRequest {
  readonly taskId: string;
  readonly converterId: string;
  readonly input: {
    readonly path: string;
    readonly format: string;
    readonly size: number;
  };
  readonly output: { readonly path: string; readonly format: string };
  readonly options: Record<string, unknown>;
  readonly scratchDir: string;
  readonly signal: AbortSignal;
  readonly onProgress: (e: { ratio: number; message?: string }) => void;
}

export interface HopResult {
  readonly bytes?: number;
  readonly warnings?: string[];
  readonly meta?: Record<string, unknown>;
}

export class HopFailure extends Error {
  readonly code: ConversionErrorCode;
  readonly userMessage: string;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(init: {
    code: ConversionErrorCode;
    userMessage: string;
    detail?: string;
    retryable: boolean;
  }) {
    super(init.userMessage);
    this.name = 'HopFailure';
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.detail = init.detail;
    this.retryable = init.retryable;
  }
}

interface Task {
  readonly req: HopRequest;
  readonly resolve: (r: HopResult) => void;
  readonly reject: (e: HopFailure) => void;
  cancelTimer?: NodeJS.Timeout;
  abortListener?: () => void;
}

class PoolWorker {
  proc: Electron.UtilityProcess;
  task: Task | null = null;
  ready = false;

  constructor(
    private readonly entryPath: string,
    private readonly onCrash: (worker: PoolWorker, task: Task) => void,
  ) {
    this.proc = this.spawn();
  }

  private spawn(): Electron.UtilityProcess {
    const proc = utilityProcess.fork(this.entryPath, [], {
      serviceName: 'file-warper-worker',
      stdio: 'pipe',
    });
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', () => {});
    proc.on('message', (message: WorkerToMainMessage) => this.handleMessage(message));
    proc.on('exit', () => {
      const task = this.task;
      this.task = null;
      this.ready = false;
      if (task) this.onCrash(this, task);
    });
    proc.on('spawn', () => {
      this.ready = true;
    });
    return proc;
  }

  get busy(): boolean {
    return this.task !== null;
  }

  respawn(): void {
    this.proc.removeAllListeners();
    this.proc = this.spawn();
  }

  kill(): void {
    this.proc.kill();
  }

  private handleMessage(message: WorkerToMainMessage): void {
    if (message.type === 'ready') return;
    const task = this.task;
    if (!task || task.req.taskId !== message.taskId) return;

    if (message.type === 'progress') {
      task.req.onProgress({ ratio: message.ratio, message: message.message });
      return;
    }
    this.settle(task, message);
  }

  private settle(task: Task, message: WorkerToMainMessage): void {
    if (task.cancelTimer) clearTimeout(task.cancelTimer);
    if (task.abortListener)
      task.req.signal.removeEventListener('abort', task.abortListener);
    this.task = null;

    if (message.type === 'done') {
      task.resolve({
        bytes: message.bytes,
        warnings: message.warnings,
        meta: message.meta,
      });
    } else if (message.type === 'cancelled') {
      task.reject(
        new HopFailure({
          code: 'E_CANCELLED',
          userMessage: 'Conversion cancelled.',
          retryable: false,
        }),
      );
    } else if (message.type === 'error') {
      task.reject(
        new HopFailure({
          code: message.code,
          userMessage: message.userMessage,
          detail: message.detail,
          retryable: message.retryable,
        }),
      );
    }
  }

  run(req: HopRequest): Promise<HopResult> {
    return new Promise((resolve, reject) => {
      const task: Task = { req, resolve, reject };
      this.task = task;

      const runMsg: RunHopMessage = {
        type: 'run',
        taskId: req.taskId,
        converterId: req.converterId,
        input: req.input,
        output: req.output,
        options: req.options,
        scratchDir: req.scratchDir,
      };

      task.abortListener = () => {
        this.proc.postMessage({ type: 'cancel', taskId: req.taskId });
        task.cancelTimer = setTimeout(() => {
          // Worker ignored cancellation for 5s -> hard-kill and respawn.
          // Its (single) in-flight task is "innocent" only if it isn't this
          // one; this one is the one that refused to cancel, so it fails.
          if (this.task === task) {
            this.task = null;
            this.kill();
            this.respawn();
            task.reject(
              new HopFailure({
                code: 'E_WORKER_CRASH',
                userMessage: 'This conversion had to be force-stopped.',
                retryable: false,
              }),
            );
          }
        }, CANCEL_ACK_TIMEOUT_MS);
      };
      req.signal.addEventListener('abort', task.abortListener, { once: true });

      this.proc.postMessage(runMsg);
    });
  }
}

export class WorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly entryPath: string;

  constructor(
    private readonly size: number = defaultPoolSize(),
    entryPath?: string,
  ) {
    this.entryPath = entryPath ?? path.join(__dirname, '../worker/entry.js');
  }

  start(): void {
    for (let i = 0; i < this.size; i++) {
      this.workers.push(
        new PoolWorker(this.entryPath, (worker, task) => this.handleCrash(worker, task)),
      );
    }
  }

  private handleCrash(worker: PoolWorker, task: Task): void {
    if (task.cancelTimer) clearTimeout(task.cancelTimer);
    if (task.abortListener)
      task.req.signal.removeEventListener('abort', task.abortListener);
    worker.respawn();
    task.reject(
      new HopFailure({
        code: 'E_WORKER_CRASH',
        userMessage: 'The conversion engine crashed unexpectedly.',
        retryable: true,
      }),
    );
  }

  /** Idle worker count — the admission-control signal for the scheduler. */
  availableSlots(): number {
    return this.workers.filter((w) => w.ready && !w.busy).length;
  }

  poolSize(): number {
    return this.size;
  }

  async runHop(req: HopRequest): Promise<HopResult> {
    const worker = this.workers.find((w) => w.ready && !w.busy);
    if (!worker) {
      throw new HopFailure({
        code: 'E_ENGINE',
        userMessage: 'No conversion worker is available right now.',
        retryable: true,
      });
    }
    return worker.run(req);
  }

  shutdown(): void {
    for (const worker of this.workers) worker.kill();
  }
}
