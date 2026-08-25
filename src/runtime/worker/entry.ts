/**
 * utilityProcess entry point. Runs with full Node APIs (not sandboxed) but is
 * otherwise isolated from Electron main: a native crash or OOM here kills
 * only this process, which is the whole point of not using `worker_threads`.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { ALL_CONVERTERS } from '@converters/index';
import { ConverterRegistry } from '@core/registry';
import type { ConversionError, ConversionInput, ConvertContext } from '@core/types';
import type {
  CancelTaskMessage,
  MainToWorkerMessage,
  RunHopMessage,
  WorkerToMainMessage,
} from '../worker-protocol';

const workerConverters = ALL_CONVERTERS.filter(
  (c) => (c.residency ?? 'worker') === 'worker',
);
const registry = new ConverterRegistry();
for (const converter of workerConverters) registry.register(converter);
const converterById = new Map(workerConverters.map((c) => [c.id, c]));

const inflight = new Map<string, AbortController>();

function post(msg: WorkerToMainMessage): void {
  process.parentPort.postMessage(msg);
}

function makeInput(path: string, format: string, size: number): ConversionInput {
  return {
    path,
    format,
    size,
    readBuffer: () => fsp.readFile(path),
    createReadStream: () => fs.createReadStream(path),
  };
}

function isConversionError(err: unknown): err is ConversionError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'userMessage' in err &&
    'retryable' in err
  );
}

async function handleRun(msg: RunHopMessage): Promise<void> {
  const converter = converterById.get(msg.converterId);
  const controller = new AbortController();
  inflight.set(msg.taskId, controller);

  if (!converter) {
    inflight.delete(msg.taskId);
    post({
      type: 'error',
      taskId: msg.taskId,
      code: 'E_ENGINE',
      userMessage: 'The engine for this conversion step is not available.',
      detail: `unknown converterId: ${msg.converterId}`,
      retryable: false,
    });
    return;
  }

  const ctx: ConvertContext = {
    onProgress: (e) =>
      post({ type: 'progress', taskId: msg.taskId, ratio: e.ratio, message: e.message }),
    signal: controller.signal,
    scratchDir: msg.scratchDir,
    log: () => {},
  };

  try {
    const result = await converter.convert(
      makeInput(msg.input.path, msg.input.format, msg.input.size),
      { path: msg.output.path, format: msg.output.format },
      msg.options,
      ctx,
    );
    inflight.delete(msg.taskId);
    post({
      type: 'done',
      taskId: msg.taskId,
      bytes: result.bytes,
      warnings: result.warnings,
      meta: result.meta,
    });
  } catch (err) {
    inflight.delete(msg.taskId);
    if (controller.signal.aborted) {
      post({ type: 'cancelled', taskId: msg.taskId });
      return;
    }
    if (isConversionError(err)) {
      post({
        type: 'error',
        taskId: msg.taskId,
        code: err.code,
        userMessage: err.userMessage,
        detail: err.detail,
        retryable: err.retryable,
      });
      return;
    }
    post({
      type: 'error',
      taskId: msg.taskId,
      code: 'E_ENGINE',
      userMessage: 'This conversion failed unexpectedly.',
      detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
      retryable: false,
    });
  }
}

function handleCancel(msg: CancelTaskMessage): void {
  inflight.get(msg.taskId)?.abort();
}

process.parentPort.on('message', (event) => {
  const msg = event.data as MainToWorkerMessage;
  if (msg.type === 'run') void handleRun(msg);
  else if (msg.type === 'cancel') handleCancel(msg);
});

post({ type: 'ready' });
