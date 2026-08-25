/**
 * The job queue: FIFO within a batch, round-robin across batches. Routes at
 * enqueue time so unroutable files come back `skipped` before any work
 * starts. Executes multi-hop routes per docs/spec-core-architecture.md §2.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { extensionFor, getFormat } from '@core/formats';
import type {
  BatchId,
  Converter,
  ConverterId,
  ConverterOptions,
  EnqueueRequest,
  FormatId,
  JobId,
  JobState,
  JobSummary,
  Route,
  RouteStep,
  SerializedError,
} from '@core/types';
import type { WarpEvent } from '@shared/ipc';
import { ALL_CONVERTERS_STUB } from './converters-registry-stub';
import { ConverterRegistry, Router } from './local-graph';
import type { MainConvertContext, MainHopRunner } from './main-runner';
import { computeOutputPath, createReservation, type NameReservation } from './naming';
import { HopFailure, type WorkerPool } from './pool';
import * as temp from './temp';

const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MS_PER_MB = 2000;
const BYTES_PER_MB = 1_000_000;

const ENGINE_LIMITS: Record<string, number> = { ffmpeg: 2, sharp: 4, chromium: 2 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function jobTimeoutMs(size: number): number {
  return clamp(
    MIN_TIMEOUT_MS + (size / BYTES_PER_MB) * MS_PER_MB,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
}

class Semaphore {
  private inUse = 0;
  constructor(private readonly limit: number) {}
  tryAcquire(): (() => void) | null {
    if (this.inUse >= this.limit) return null;
    this.inUse++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse--;
    };
  }
}

interface RuntimeJob {
  readonly id: JobId;
  readonly batchId: BatchId;
  readonly inputPath: string;
  readonly inputName: string;
  readonly inputFormat: FormatId | null;
  readonly inputSize: number;
  readonly target: FormatId;
  readonly options: ConverterOptions;
  readonly outputPath: string;
  readonly route: Route | null;
  state: JobState;
  progress: number;
  hop: { index: number; total: number } | null;
  error?: SerializedError;
  warnings: string[];
  controller: AbortController;
  timeoutTimer?: NodeJS.Timeout;
  hopRetried: boolean;
  dispatched: boolean;
}

interface BatchState {
  readonly id: BatchId;
  readonly jobIds: JobId[];
  cursor: number;
  ok: number;
  failed: number;
  skipped: number;
  finished: number;
  readonly outputDirs: Set<string>;
}

export interface DetectedInput {
  readonly format: FormatId | null;
  readonly size: number;
}

export type DetectFn = (filePath: string) => Promise<DetectedInput>;

const ROUTE_FACTORS: Record<string, number> = {
  image: 1.5,
  video: 3,
  audio: 1.5,
  archive: 1.2,
};
const DEFAULT_ROUTE_FACTOR = 1.5;
const RAW_TARGET_FACTOR = 10;

function routeFactorFor(target: FormatId): number {
  const def = getFormat(target);
  if (!def) return DEFAULT_ROUTE_FACTOR;
  if (!def.lossy && !def.binary) return RAW_TARGET_FACTOR;
  return ROUTE_FACTORS[def.category] ?? DEFAULT_ROUTE_FACTOR;
}

export class Scheduler extends EventEmitter {
  private readonly registry = new ConverterRegistry();
  private readonly router: Router;
  private readonly converterById = new Map<ConverterId, Converter>();
  private readonly jobs = new Map<JobId, RuntimeJob>();
  private readonly batches = new Map<BatchId, BatchState>();
  private readonly batchOrder: BatchId[] = [];
  private readonly reservation: NameReservation = createReservation();
  private readonly semaphores = new Map<string, Semaphore>();
  private pumping = false;

  constructor(
    private readonly pool: WorkerPool,
    private readonly mainRunner: MainHopRunner,
    private readonly detect: DetectFn,
  ) {
    super();
    for (const converter of ALL_CONVERTERS_STUB) {
      this.registry.register(converter);
      this.converterById.set(converter.id, converter);
    }
    this.router = new Router(this.registry);
  }

  async refreshAvailability(): Promise<void> {
    await this.registry.refreshAvailability();
  }

  availabilitySnapshot() {
    return this.registry.availabilitySnapshot();
  }

  targetsFor(formats: readonly FormatId[]) {
    return this.router.targetsForAll(formats);
  }

  private emitEvent(e: WarpEvent): void {
    this.emit('event', e);
  }

  private engineSemaphore(engine: string, poolSize: number): Semaphore {
    let sem = this.semaphores.get(engine);
    if (!sem) {
      sem = new Semaphore(ENGINE_LIMITS[engine] ?? poolSize);
      this.semaphores.set(engine, sem);
    }
    return sem;
  }

  private toSummary(job: RuntimeJob): JobSummary {
    return {
      id: job.id,
      batchId: job.batchId,
      inputPath: job.inputPath,
      inputName: job.inputName,
      inputFormat: job.inputFormat,
      target: job.target,
      outputPath: job.outputPath,
      state: job.state,
      hops: job.route?.steps.length ?? 0,
      lossless: job.route?.lossless ?? false,
    };
  }

  async enqueue(req: EnqueueRequest): Promise<{ batchId: BatchId; jobs: JobSummary[] }> {
    const batchId = randomUUID();
    const batch: BatchState = {
      id: batchId,
      jobIds: [],
      cursor: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      finished: 0,
      outputDirs: new Set(),
    };

    let totalBytes = 0;
    const factor = routeFactorFor(req.target);
    const detected: { filePath: string; info: DetectedInput }[] = [];
    for (const filePath of req.paths) {
      const info = await this.detect(filePath).catch(
        () => ({ format: null, size: 0 }) as DetectedInput,
      );
      detected.push({ filePath, info });
      totalBytes += info.size;
    }

    const outputDirsForGuard = new Set<string>();
    for (const { filePath } of detected) {
      outputDirsForGuard.add(this.previewOutputDir(filePath, req));
    }
    const requiredBytes = totalBytes * factor;
    for (const dir of outputDirsForGuard) {
      const check = await temp.checkDiskSpace(dir, requiredBytes);
      if (!check.ok) {
        return this.failBatchOnDiskGuard(batchId, req, detected);
      }
    }

    const summaries: JobSummary[] = [];
    for (const { filePath, info } of detected) {
      const job = this.createJob(batchId, filePath, info, req);
      this.jobs.set(job.id, job);
      batch.jobIds.push(job.id);
      if (job.state === 'skipped') {
        batch.skipped++;
        batch.finished++;
      } else if (job.outputPath) {
        batch.outputDirs.add(path.dirname(job.outputPath));
      }
      summaries.push(this.toSummary(job));
    }

    this.batches.set(batchId, batch);
    this.batchOrder.push(batchId);
    this.emitEvent({ t: 'batch:created', batchId, jobs: summaries });
    this.maybeFinishBatch(batch);
    this.pump();
    return { batchId, jobs: summaries };
  }

  private previewOutputDir(filePath: string, req: EnqueueRequest): string {
    if (req.output.mode === 'alongside') return path.dirname(filePath);
    if (req.output.mode === 'fixed') return req.output.dir;
    const rel = path.relative(req.output.sourceRoot, path.dirname(filePath));
    return path.join(req.output.root, rel);
  }

  private failBatchOnDiskGuard(
    batchId: BatchId,
    req: EnqueueRequest,
    detected: { filePath: string; info: DetectedInput }[],
  ): { batchId: BatchId; jobs: JobSummary[] } {
    const batch: BatchState = {
      id: batchId,
      jobIds: [],
      cursor: 0,
      ok: 0,
      failed: detected.length,
      skipped: 0,
      finished: detected.length,
      outputDirs: new Set(),
    };
    const summaries: JobSummary[] = [];
    for (const { filePath, info } of detected) {
      const job = this.createJob(batchId, filePath, info, req, true);
      job.state = 'failed';
      job.error = {
        code: 'E_DISK_FULL',
        userMessage: "There isn't enough free disk space to convert these files.",
        retryable: true,
      };
      this.jobs.set(job.id, job);
      batch.jobIds.push(job.id);
      summaries.push(this.toSummary(job));
    }
    this.batches.set(batchId, batch);
    this.batchOrder.push(batchId);
    this.emitEvent({ t: 'batch:created', batchId, jobs: summaries });
    for (const jobId of batch.jobIds) {
      this.emitEvent({ t: 'job:state', jobId, state: 'failed' });
      const job = this.jobs.get(jobId);
      if (job?.error) this.emitEvent({ t: 'job:error', jobId, error: job.error });
    }
    this.emitEvent({ t: 'batch:done', batchId, ok: 0, failed: batch.failed, skipped: 0 });
    return { batchId, jobs: summaries };
  }

  private createJob(
    batchId: BatchId,
    filePath: string,
    info: DetectedInput,
    req: EnqueueRequest,
    skipRouting = false,
  ): RuntimeJob {
    const route =
      !skipRouting && info.format
        ? (this.router.routeFor(info.format, req.target) ?? null)
        : null;
    const outputPath =
      !skipRouting && route
        ? computeOutputPath({
            inputPath: filePath,
            target: req.target,
            location: req.output,
            collision: req.collision,
            reservation: this.reservation,
          })
        : '';

    const state: JobState =
      skipRouting || !route || outputPath === '' ? 'skipped' : 'queued';
    const job: RuntimeJob = {
      id: randomUUID(),
      batchId,
      inputPath: filePath,
      inputName: path.basename(filePath),
      inputFormat: info.format,
      inputSize: info.size,
      target: req.target,
      options: req.options,
      outputPath,
      route,
      state,
      progress: 0,
      hop: null,
      warnings: [],
      controller: new AbortController(),
      hopRetried: false,
      dispatched: false,
    };
    if (state === 'skipped' && !job.error) {
      job.error = {
        code: 'E_NO_ROUTE',
        userMessage: `File Warper doesn't know how to convert this to ${req.target}.`,
        retryable: false,
      };
    }
    return job;
  }

  cancelJob(jobId: JobId): void {
    const job = this.jobs.get(jobId);
    if (
      !job ||
      job.state === 'succeeded' ||
      job.state === 'failed' ||
      job.state === 'cancelled'
    )
      return;
    job.controller.abort();
    if (!job.dispatched) this.finishJob(job, 'cancelled');
  }

  cancelBatch(batchId: BatchId): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;
    for (const jobId of batch.jobIds) this.cancelJob(jobId);
  }

  shutdownAll(): void {
    for (const job of this.jobs.values()) job.controller.abort();
  }

  // ---------------------------------------------------------------------
  // Pump: FIFO within a batch, round-robin across batches.
  // ---------------------------------------------------------------------

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let progressed = true;
      while (progressed) {
        progressed = false;
        const job = this.nextRunnableJob();
        if (!job) break;
        job.dispatched = true;
        progressed = true;
        void this.runJob(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  private nextRunnableJob(): RuntimeJob | null {
    const attempts = this.batchOrder.length;
    for (let i = 0; i < attempts; i++) {
      const batchId = this.batchOrder[0];
      if (batchId === undefined) return null;
      const batch = this.batches.get(batchId);
      if (!batch) {
        this.batchOrder.shift();
        continue;
      }
      while (batch.cursor < batch.jobIds.length) {
        const jobId = batch.jobIds[batch.cursor];
        const job = jobId ? this.jobs.get(jobId) : undefined;
        if (job?.state !== 'queued' || job.dispatched) {
          batch.cursor++;
          continue;
        }
        // Rotate this batch to the back so the next pump() call gives
        // another batch a turn — round-robin across batches.
        this.batchOrder.push(this.batchOrder.shift() as BatchId);
        return job;
      }
      // This batch has nothing left to dispatch right now; try the next one.
      this.batchOrder.push(this.batchOrder.shift() as BatchId);
    }
    return null;
  }

  private async runJob(job: RuntimeJob): Promise<void> {
    if (!job.route) {
      this.finishJob(job, 'failed');
      return;
    }
    job.state = 'running';
    this.emitEvent({ t: 'job:state', jobId: job.id, state: 'running' });
    const dir = await temp.jobDir(job.id);
    job.timeoutTimer = setTimeout(
      () => job.controller.abort(),
      jobTimeoutMs(job.inputSize),
    );

    let cur = job.inputPath;
    const staged: string[] = [];
    let timedOut = false;
    job.controller.signal.addEventListener('abort', () => {
      timedOut = true;
    });

    try {
      for (let i = 0; i < job.route.steps.length; i++) {
        const step = job.route.steps[i];
        if (!step) continue;
        const isLast = i === job.route.steps.length - 1;
        const dest = isLast
          ? temp.stagingPathBeside(job.outputPath)
          : path.join(dir, `hop${i}.${extensionFor(step.to)}`);
        if (isLast) staged.push(dest);

        await this.runHopWithRetry(job, step, i, cur, dest);
        await this.assertNonEmpty(dest);
        cur = dest;
      }
      await temp.commitStaged(cur, job.outputPath);
      const bytes = await fsp
        .stat(job.outputPath)
        .then((s) => s.size)
        .catch(() => 0);
      this.finishJob(job, 'succeeded', { outputPath: job.outputPath, bytes });
    } catch (err) {
      for (const s of staged) await temp.discardStaged(s);
      const failure = this.toFailure(err);
      if (job.controller.signal.aborted && timedOut && failure.code !== 'E_CANCELLED') {
        this.finishJob(job, 'failed', undefined, {
          code: 'E_TIMEOUT',
          userMessage: 'This conversion took too long and was stopped.',
          retryable: true,
        });
      } else if (job.controller.signal.aborted) {
        this.finishJob(job, 'cancelled');
      } else {
        this.finishJob(job, 'failed', undefined, {
          code: failure.code,
          userMessage: failure.userMessage,
          detail: failure.detail,
          retryable: failure.retryable,
        });
      }
    } finally {
      if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
      await temp.cleanupJobDir(job.id);
      this.pump();
    }
  }

  private async runHopWithRetry(
    job: RuntimeJob,
    step: RouteStep,
    index: number,
    input: string,
    output: string,
  ): Promise<void> {
    try {
      await this.dispatchHop(
        job,
        step.converterId,
        step.from,
        step.to,
        index,
        input,
        output,
      );
    } catch (err) {
      const failure = this.toFailure(err);
      if (job.controller.signal.aborted || failure.code === 'E_CANCELLED') throw err;
      const fallback = this.router.fallbackFor(step.from, step.to);
      if (!job.hopRetried && fallback && fallback.converterId !== step.converterId) {
        job.hopRetried = true;
        await this.dispatchHop(
          job,
          fallback.converterId,
          step.from,
          step.to,
          index,
          input,
          output,
        );
        return;
      }
      if (!job.hopRetried && failure.code === 'E_WORKER_CRASH') {
        job.hopRetried = true;
        await this.dispatchHop(
          job,
          step.converterId,
          step.from,
          step.to,
          index,
          input,
          output,
        );
        return;
      }
      throw err;
    }
  }

  private async dispatchHop(
    job: RuntimeJob,
    converterId: ConverterId,
    from: FormatId,
    to: FormatId,
    index: number,
    input: string,
    output: string,
  ): Promise<void> {
    const converter = this.converterById.get(converterId);
    if (!converter) {
      throw new HopFailure({
        code: 'E_ENGINE',
        userMessage: 'This conversion step is not available.',
        retryable: false,
      });
    }

    const total = job.route?.steps.length ?? 1;
    const weights = (job.route?.steps ?? []).map((s) => {
      const c = this.converterById.get(s.converterId);
      return Math.max(1, c?.cost(s.from, s.to).effort ?? 1);
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    const before = weights.slice(0, index).reduce((a, b) => a + b, 0);
    const hopWeight = weights[index] ?? 1;

    const onProgress = (ratio: number) => {
      const overall =
        ratio < 0
          ? -1
          : (before + Math.max(0, Math.min(1, ratio)) * hopWeight) / totalWeight;
      job.progress = overall;
      job.hop = { index, total };
      this.emitEvent({
        t: 'job:progress',
        jobId: job.id,
        progress: overall,
        hop: { index, total },
      });
    };

    const size = index === 0 ? job.inputSize : 0;
    const scratchDir = await temp.jobDir(job.id);

    if ((converter.residency ?? 'worker') === 'main') {
      const release = this.engineSemaphore(
        converter.engine,
        this.pool.poolSize(),
      ).tryAcquire();
      if (!release) {
        await this.waitForCapacity();
        return this.dispatchHop(job, converterId, from, to, index, input, output);
      }
      try {
        const ctx: MainConvertContext = {
          onProgress: (e) => onProgress(e.ratio),
          signal: job.controller.signal,
          scratchDir,
          log: () => {},
          main: this.mainRunner,
        };
        const inputHandle = {
          path: input,
          format: from,
          size,
          readBuffer: () => fsp.readFile(input),
          createReadStream: () => fs.createReadStream(input),
        };
        await converter.convert(
          inputHandle,
          { path: output, format: to },
          job.options,
          ctx,
        );
      } finally {
        release();
      }
      return;
    }

    const release = this.engineSemaphore(
      converter.engine,
      this.pool.poolSize(),
    ).tryAcquire();
    if (!release) {
      await this.waitForCapacity();
      return this.dispatchHop(job, converterId, from, to, index, input, output);
    }
    try {
      await this.pool.runHop({
        taskId: randomUUID(),
        converterId,
        input: { path: input, format: from, size },
        output: { path: output, format: to },
        options: job.options,
        scratchDir,
        signal: job.controller.signal,
        onProgress: (e) => onProgress(e.ratio),
      });
    } finally {
      release();
    }
  }

  private waitForCapacity(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
  }

  private toFailure(err: unknown): {
    code: SerializedError['code'];
    userMessage: string;
    detail?: string;
    retryable: boolean;
  } {
    if (err instanceof HopFailure) {
      return {
        code: err.code,
        userMessage: err.userMessage,
        detail: err.detail,
        retryable: err.retryable,
      };
    }
    if (err instanceof Error) {
      return {
        code: 'E_ENGINE',
        userMessage: 'This conversion failed unexpectedly.',
        detail: err.stack,
        retryable: false,
      };
    }
    return {
      code: 'E_ENGINE',
      userMessage: 'This conversion failed unexpectedly.',
      retryable: false,
    };
  }

  private async assertNonEmpty(p: string): Promise<void> {
    const stat = await fsp.stat(p).catch(() => null);
    if (!stat || stat.size === 0) {
      throw new HopFailure({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'A conversion step produced an empty file.',
        retryable: true,
      });
    }
  }

  private finishJob(
    job: RuntimeJob,
    state: JobState,
    done?: { outputPath: string; bytes: number },
    error?: SerializedError,
  ): void {
    job.state = state;
    if (error) job.error = error;
    this.emitEvent({ t: 'job:state', jobId: job.id, state });
    if (state === 'succeeded' && done) {
      this.emitEvent({
        t: 'job:done',
        jobId: job.id,
        outputPath: done.outputPath,
        bytes: done.bytes,
        warnings: job.warnings,
      });
    } else if ((state === 'failed' || state === 'cancelled') && job.error) {
      this.emitEvent({ t: 'job:error', jobId: job.id, error: job.error });
    }

    const batch = this.batches.get(job.batchId);
    if (!batch) return;
    batch.finished++;
    if (state === 'succeeded') batch.ok++;
    else if (state === 'failed') batch.failed++;
    else if (state === 'skipped') batch.skipped++;
    this.maybeFinishBatch(batch);
  }

  private maybeFinishBatch(batch: BatchState): void {
    if (batch.finished < batch.jobIds.length) return;
    this.emitEvent({
      t: 'batch:done',
      batchId: batch.id,
      ok: batch.ok,
      failed: batch.failed,
      skipped: batch.skipped,
    });
    for (const dir of batch.outputDirs) void temp.sweepStaleStaging(dir).catch(() => {});
  }
}
