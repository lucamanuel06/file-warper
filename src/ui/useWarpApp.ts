'use client';

import { CATEGORY_ORDER, DEFAULT_TARGET, getFormat } from '@core/formats';
import type {
  ConverterOptions,
  EnqueueRequest,
  FormatCategory,
  FormatId,
  OutputLocation,
  TargetSet,
} from '@core/types';
import type { WarpEvent } from '@shared/ipc';
import type { AppSettings } from '@shared/settings';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EnvironmentIssue, Phase, SaveLocation, StagedFile } from './types';
import { defaultOptionsFor } from './utils/optionsConfig';

const lsKey = {
  target: (cat: FormatCategory) => `warp:lastTarget:${cat}`,
  options: (cat: FormatCategory) => `warp:options:${cat}`,
};

function readLS<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* best-effort: private mode / quota */
  }
}

function isReachable(
  sourceFormat: FormatId | null,
  target: FormatId | null,
  targetSet: TargetSet | null,
): boolean {
  if (!sourceFormat || !target || !targetSet) return true;
  if (targetSet.common.includes(target)) return true;
  return (targetSet.partial[target] ?? []).includes(sourceFormat);
}

function majorityCategory(files: StagedFile[]): FormatCategory {
  const counts = new Map<FormatCategory, number>();
  for (const f of files) {
    if (f.category) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  }
  let best: FormatCategory = 'document';
  let bestCount = -1;
  for (const cat of CATEGORY_ORDER) {
    const c = counts.get(cat) ?? 0;
    if (c > bestCount) {
      bestCount = c;
      best = cat;
    }
  }
  return best;
}

function outputLocationFrom(saveLocation: SaveLocation): OutputLocation {
  return saveLocation.mode === 'same'
    ? { mode: 'alongside' }
    : { mode: 'fixed', dir: saveLocation.dir };
}

/** The per-job "Save to" override (Options disclosure) starts from the global setting. */
function defaultSaveLocation(settings: AppSettings): SaveLocation {
  return settings.outputMode === 'fixed' && settings.outputDir
    ? { mode: 'folder', dir: settings.outputDir }
    : { mode: 'same' };
}

let idSeq = 0;
const nextId = () => `f${idSeq++}`;

export function useWarpApp(settings: AppSettings, settingsOpen: boolean) {
  const [phase, setPhase] = useState<Phase>('empty');
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [target, setTarget] = useState<FormatId | null>(null);
  const [targetSet, setTargetSet] = useState<TargetSet | null>(null);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [optionValues, setOptionValues] = useState<ConverterOptions>({});
  const [saveLocation, setSaveLocation] = useState<SaveLocation>(() =>
    defaultSaveLocation(settings),
  );
  const [dragActive, setDragActive] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [progressByJob, setProgressByJob] = useState<Record<string, number>>({});
  const [environmentIssue, setEnvironmentIssue] = useState<EnvironmentIssue | null>(null);

  const filesRef = useRef(files);
  filesRef.current = files;
  const targetRef = useRef(target);
  targetRef.current = target;
  const saveLocationRef = useRef(saveLocation);
  saveLocationRef.current = saveLocation;
  const optionValuesRef = useRef(optionValues);
  optionValuesRef.current = optionValues;
  const batchIdRef = useRef(batchId);
  batchIdRef.current = batchId;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const lastOutputPathRef = useRef<string | null>(null);

  const resetAll = useCallback(() => {
    setPhase('empty');
    setFiles([]);
    setTarget(null);
    setTargetSet(null);
    setBatchId(null);
    setProgressByJob({});
    setEnvironmentIssue(null);
    setSaveLocation(defaultSaveLocation(settingsRef.current));
  }, []);

  // Re-sync the default "Save to" location while idle, so a change made in
  // Settings (or Settings finishing its async load) takes effect for the next
  // batch without clobbering an in-session per-job override.
  useEffect(() => {
    if (phase === 'empty') setSaveLocation(defaultSaveLocation(settings));
  }, [settings, phase]);

  const applyTargetSelection = useCallback(
    async (newTarget: FormatId, ts: TargetSet | null, fileList: StagedFile[]) => {
      const cat = getFormat(newTarget)?.category ?? null;
      if (cat) writeLS(lsKey.target(cat), newTarget);
      const remoteDefaults = await window.warp.invoke('warp:optionsFor', newTarget);
      const persisted = cat ? readLS<ConverterOptions>(lsKey.options(cat)) : null;
      setOptionValues({
        ...defaultOptionsFor(cat),
        ...remoteDefaults,
        ...(persisted ?? {}),
      });
      setTarget(newTarget);
      setFiles(
        fileList.map((f) => ({
          ...f,
          reachable: isReachable(f.sourceFormat, newTarget, ts),
        })),
      );
    },
    [],
  );

  const probeAndStage = useCallback(
    async (paths: string[]) => {
      const validPaths = paths.filter(Boolean);
      if (validPaths.length === 0) return;
      const results = await window.warp.invoke('warp:probe', validPaths);
      const base = phase === 'done' ? [] : filesRef.current;
      const existing = new Set(base.map((f) => f.path));
      const additions: StagedFile[] = results
        .filter((r) => !existing.has(r.path))
        .map((r) => ({
          id: nextId(),
          path: r.path,
          name: r.name,
          size: r.size,
          sourceFormat: r.format,
          category: r.category,
          reachable: true,
          state: 'idle',
        }));
      if (additions.length === 0) return;
      const merged = [...base, ...additions];
      const distinctFormats = Array.from(
        new Set(merged.map((f) => f.sourceFormat).filter((f): f is FormatId => !!f)),
      );
      const newTargetSet = await window.warp.invoke('warp:targets', distinctFormats);
      const current = targetRef.current;
      const stillReachable =
        !!current &&
        (newTargetSet.common.includes(current) || current in newTargetSet.partial);
      let nextTarget: FormatId;
      if (stillReachable && current) {
        nextTarget = current;
      } else {
        const cat = majorityCategory(merged);
        nextTarget = readLS<FormatId>(lsKey.target(cat)) ?? DEFAULT_TARGET[cat];
      }
      setTargetSet(newTargetSet);
      await applyTargetSelection(nextTarget, newTargetSet, merged);
      setPhase('staged');
    },
    [phase, applyTargetSelection],
  );

  const resolveAndStage = useCallback(
    async (domFiles: File[], paths: string[]) => {
      const finalPaths: string[] = [];
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        if (p) {
          finalPaths.push(p);
          continue;
        }
        const file = domFiles[i];
        if (!file) continue;
        const buf = await file.arrayBuffer();
        finalPaths.push(await window.warp.invoke('temp:spill', file.name, buf));
      }
      await probeAndStage(finalPaths);
    },
    [probeAndStage],
  );

  const browse = useCallback(async () => {
    const paths = await window.warp.invoke('dialog:pickFiles');
    await probeAndStage(paths);
  }, [probeAndStage]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      // MUST read synchronously — DataTransfer is neutered after any await.
      const droppedFiles = Array.from(e.dataTransfer.files);
      const paths = window.warp.pathsForFiles(droppedFiles);
      void resolveAndStage(droppedFiles, paths);
    },
    [resolveAndStage],
  );

  const removeFile = useCallback(
    async (id: string) => {
      const remaining = filesRef.current.filter((f) => f.id !== id);
      if (remaining.length === 0) {
        resetAll();
        return;
      }
      const distinctFormats = Array.from(
        new Set(remaining.map((f) => f.sourceFormat).filter((f): f is FormatId => !!f)),
      );
      const ts = await window.warp.invoke('warp:targets', distinctFormats);
      setTargetSet(ts);
      setFiles(
        remaining.map((f) => ({
          ...f,
          reachable: isReachable(f.sourceFormat, targetRef.current, ts),
        })),
      );
    },
    [resetAll],
  );

  const changeTarget = useCallback(
    (newTarget: FormatId) => {
      void applyTargetSelection(newTarget, targetSet, filesRef.current);
    },
    [targetSet, applyTargetSelection],
  );

  const updateOption = useCallback((key: string, value: string | boolean) => {
    setOptionValues((prev) => {
      const next = { ...prev, [key]: value };
      const cat = targetRef.current ? getFormat(targetRef.current)?.category : null;
      if (cat) writeLS(lsKey.options(cat), next);
      return next;
    });
  }, []);

  const chooseFolder = useCallback(async () => {
    const dir = await window.warp.invoke('dialog:pickFolder');
    if (dir) setSaveLocation({ mode: 'folder', dir });
  }, []);
  const revertSaveLocation = useCallback(() => setSaveLocation({ mode: 'same' }), []);

  const applyEnqueueResult = useCallback(
    (
      id: string,
      jobs: {
        id: string;
        inputPath: string;
        state: StagedFile['state'];
        target: FormatId;
      }[],
    ) => {
      setBatchId(id);
      setFiles((prev) =>
        prev.map((f) => {
          const job = jobs.find((j) => j.inputPath === f.path);
          return job
            ? {
                ...f,
                jobId: job.id,
                state: job.state,
                outputFormat: job.target,
                error: undefined,
                expanded: false,
              }
            : f;
        }),
      );
      setPhase('converting');
      setEnvironmentIssue(null);
    },
    [],
  );

  const buildEnqueueRequest = useCallback(
    (paths: string[], target: FormatId): EnqueueRequest => ({
      paths,
      target,
      options: {
        ...optionValuesRef.current,
        preserveMetadata: settingsRef.current.preserveMetadata,
      },
      output: outputLocationFrom(saveLocationRef.current),
      collision: settingsRef.current.collision,
    }),
    [],
  );

  const convert = useCallback(async () => {
    if (phase !== 'staged' || !targetRef.current) return;
    const req = buildEnqueueRequest(
      filesRef.current.map((f) => f.path),
      targetRef.current,
    );
    const { batchId: id, jobs } = await window.warp.invoke('warp:enqueue', req);
    applyEnqueueResult(id, jobs);
  }, [phase, applyEnqueueResult, buildEnqueueRequest]);

  const retryFailed = useCallback(async () => {
    const failed = filesRef.current.filter((f) => f.state === 'failed');
    if (failed.length === 0 || !targetRef.current) return;
    const req = buildEnqueueRequest(
      failed.map((f) => f.path),
      targetRef.current,
    );
    const { batchId: id, jobs } = await window.warp.invoke('warp:enqueue', req);
    applyEnqueueResult(id, jobs);
  }, [applyEnqueueResult, buildEnqueueRequest]);

  const cancel = useCallback(() => {
    if (batchIdRef.current)
      void window.warp.invoke('warp:cancelBatch', batchIdRef.current);
  }, []);

  const revealFile = useCallback((path: string) => {
    void window.warp.invoke('shell:reveal', path);
  }, []);
  const revealAll = useCallback(() => {
    const first = filesRef.current.find((f) => f.state === 'succeeded' && f.outputPath);
    if (first?.outputPath) void window.warp.invoke('shell:reveal', first.outputPath);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, expanded: !f.expanded } : f)),
    );
  }, []);
  const copyDetails = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text);
  }, []);
  const toggleOptions = useCallback(() => setOptionsExpanded((v) => !v), []);

  const clear = useCallback(() => resetAll(), [resetAll]);
  const done = useCallback(() => resetAll(), [resetAll]);

  // Event subscription — uses the disposer the bridge returns, per @shared/ipc's contract.
  useEffect(() => {
    const off = window.warp.on('warp:events', (events) => {
      setFiles((prev) => {
        let next = prev;
        for (const e of events) next = applyEvent(next, e);
        return next;
      });
      setProgressByJob((prev) => {
        const additions = events.filter(
          (e): e is Extract<WarpEvent, { t: 'job:progress' }> => e.t === 'job:progress',
        );
        if (additions.length === 0) return prev;
        const next = { ...prev };
        for (const e of additions) next[e.jobId] = e.progress;
        return next;
      });
      for (const e of events) {
        if (e.t === 'job:done') lastOutputPathRef.current = e.outputPath;
      }
      if (events.some((e) => e.t === 'batch:done')) {
        setPhase('done');
        if (settingsRef.current.revealWhenDone && lastOutputPathRef.current) {
          void window.warp.invoke('shell:reveal', lastOutputPathRef.current);
        }
      }
    });
    return off;
  }, []);

  // Global drop guard — without this Chromium navigates the whole app away.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // Esc priority: settings sheet (owns its own Esc handling) -> collapse
  // Options -> cancel conversion. Never clears a staged list.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (settingsOpen) return;
      if (e.key === 'Escape') {
        if (optionsExpanded) {
          setOptionsExpanded(false);
          return;
        }
        if (phase === 'converting') cancel();
        return;
      }
      if (
        e.key === 'Enter' &&
        phase === 'staged' &&
        document.activeElement === document.body
      ) {
        void convert();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [optionsExpanded, phase, cancel, convert, settingsOpen]);

  // Environment-level banner: only when EVERY attempted job failed with the same error code.
  useEffect(() => {
    if (phase !== 'done') return;
    const attempted = files.filter((f) => f.state !== 'skipped');
    const failed = attempted.filter((f) => f.state === 'failed' && f.error);
    if (attempted.length === 0 || failed.length !== attempted.length) {
      setEnvironmentIssue(null);
      return;
    }
    const codes = new Set(failed.map((f) => f.error?.code));
    if (codes.size !== 1) return;
    const [code] = codes;
    if (code === 'E_UNAVAILABLE') {
      setEnvironmentIssue({
        message: 'A required conversion engine is missing.',
        actionLabel: 'Report issue',
        action: () => console.info('[warp] report issue: engine unavailable'),
      });
    } else if (code === 'E_PERMISSION') {
      setEnvironmentIssue({
        message: 'The output folder is not writable.',
        actionLabel: 'Choose another folder…',
        action: () => void chooseFolder(),
      });
    }
  }, [phase, files, chooseFolder]);

  const willConvertCount = useMemo(
    () => files.filter((f) => f.reachable).length,
    [files],
  );

  const overallProgress = useMemo(() => {
    const active = files.filter((f) => f.state !== 'skipped' && f.state !== 'idle');
    if (active.length === 0) return 0;
    const sum = active.reduce((acc, f) => {
      if (f.state === 'succeeded' || f.state === 'failed' || f.state === 'cancelled')
        return acc + 1;
      if (f.state === 'running') return acc + (progressByJob[f.jobId ?? ''] ?? 0);
      return acc;
    }, 0);
    return sum / active.length;
  }, [files, progressByJob]);

  const statusText = useMemo(() => {
    if (phase === 'converting') {
      const total = files.length;
      const doneCount = files.filter(
        (f) =>
          f.state === 'succeeded' ||
          f.state === 'failed' ||
          f.state === 'cancelled' ||
          f.state === 'skipped',
      ).length;
      return `Converting ${Math.min(doneCount + 1, total)} of ${total}…`;
    }
    if (phase === 'done') {
      const succeeded = files.filter((f) => f.state === 'succeeded').length;
      const failed = files.filter((f) => f.state === 'failed').length;
      return failed === 0
        ? `${succeeded} file${succeeded === 1 ? '' : 's'} converted`
        : `${succeeded} converted · ${failed} failed`;
    }
    return '';
  }, [phase, files]);

  const hasFailed = useMemo(() => files.some((f) => f.state === 'failed'), [files]);
  const targetCategory = target ? (getFormat(target)?.category ?? null) : null;
  const targetDef = target ? getFormat(target) : undefined;

  return {
    phase,
    files,
    target,
    targetSet,
    targetCategory,
    targetDef,
    optionsExpanded,
    optionValues,
    saveLocation,
    dragActive,
    environmentIssue,
    willConvertCount,
    overallProgress,
    statusText,
    hasFailed,
    browse,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeFile,
    changeTarget,
    updateOption,
    chooseFolder,
    revertSaveLocation,
    convert,
    cancel,
    retryFailed,
    revealFile,
    revealAll,
    toggleExpand,
    copyDetails,
    toggleOptions,
    clear,
    done,
  };
}

function applyEvent(prev: StagedFile[], e: WarpEvent): StagedFile[] {
  switch (e.t) {
    case 'batch:created':
      return prev.map((f) => {
        const job = e.jobs.find((j) => j.inputPath === f.path);
        return job
          ? { ...f, jobId: job.id, state: job.state, outputFormat: job.target }
          : f;
      });
    case 'job:state':
      return prev.map((f) => (f.jobId === e.jobId ? { ...f, state: e.state } : f));
    case 'job:done':
      return prev.map((f) =>
        f.jobId === e.jobId ? { ...f, state: 'succeeded', outputPath: e.outputPath } : f,
      );
    case 'job:error':
      return prev.map((f) =>
        f.jobId === e.jobId ? { ...f, state: 'failed', error: e.error } : f,
      );
    default:
      return prev;
  }
}
