# File Warper — Core Conversion Architecture

**Status:** design spec, ready to implement
**Scope:** converter plugin contract, format graph/routing, format taxonomy, job execution, temp/output policy, testing

---

## 0. Package boundaries (decide this first — everything else depends on it)

```
packages/
  core/        @warp/core        pure TS. ZERO runtime deps. ZERO electron, ZERO native.
                                 formats registry, graph, Dijkstra, types, errors, magic table.
                                 -> safely bundled into the Next.js renderer.
  converters/  @warp/converters  the actual engines (sharp, ffmpeg, mammoth, pdf-lib, ...).
                                 imports @warp/core types only. Never imported by renderer.
  runtime/     @warp/runtime     scheduler, utilityProcess host, temp manager, job queue.
                                 imports core + converters. Main-process only.
apps/
  desktop/     electron main + preload  (thin: wires runtime <-> IPC)
  ui/          next.js renderer         (imports @warp/core for types + format metadata)
```

**Why:** the renderer needs the format list, categories, icons, extensions and labels to render pickers *without* an IPC round-trip. That data must therefore be dependency-free and bundleable. Everything dynamic (which converters are actually available, which targets are reachable) crosses IPC. This split is load-bearing — do not let `sharp` leak into `@warp/core`.

---

## 1. The Converter plugin contract

```ts
// @warp/core/src/types.ts

export type FormatId = string;              // canonical id, e.g. 'jpeg', 'tar.gz'
export type ConverterId = string;           // stable & unique, e.g. 'sharp:raster'
export type EngineId = 'sharp' | 'ffmpeg' | 'chromium' | 'pure-js' | 'node' | string;

/** Where the hop must physically execute. */
export type Residency =
  | 'worker'   // default: utilityProcess pool
  | 'main';    // needs Electron main APIs (BrowserWindow.printToPDF)

export interface EdgeCost {
  /** Quality retained through this hop, 0..1. 1 = lossless. Multiplicative across hops. */
  retention: number;
  /** Relative CPU/wall cost hint, 1 = trivial, 10 = transcode a video. Tie-breaker only. */
  effort: number;
  /** Structural fidelity retained (layout, metadata, layers, tags), 0..1. */
  structure?: number;
}

export type Availability =
  | { available: true; version?: string }
  | { available: false; reason: string; remedy?: string };

export interface ConversionInput {
  readonly path: string;
  readonly format: FormatId;
  readonly size: number;
  /** Convenience for pure-JS engines that want the whole thing in memory. */
  readBuffer(): Promise<Buffer>;
  createReadStream(): NodeJS.ReadableStream;
}

export interface ConversionOutput {
  /** Absolute path the converter MUST write to. Parent dir already exists. */
  readonly path: string;
  readonly format: FormatId;
}

export interface ProgressEvent {
  /** 0..1 within this hop. Emit -1 for indeterminate. */
  ratio: number;
  message?: string;
}

export interface ConvertContext {
  onProgress(e: ProgressEvent): void;
  /** Aborted on user cancel, batch cancel, or app quit. Converters MUST honour it. */
  readonly signal: AbortSignal;
  /** Scratch dir owned by the executor; auto-deleted. Safe for engine spill files. */
  readonly scratchDir: string;
  readonly log: (msg: string, data?: unknown) => void;
}

export interface ConvertResult {
  /** Bytes written. Executor verifies path exists & size > 0 regardless. */
  bytes?: number;
  /** Non-fatal notes surfaced in the UI ("dropped alpha channel", "kept first page only"). */
  warnings?: string[];
  /** Engine-observed metadata, cached for later hops (dimensions, duration, page count). */
  meta?: Record<string, unknown>;
}

export interface Converter<TOptions = Record<string, unknown>> {
  readonly id: ConverterId;
  readonly name: string;
  readonly engine: EngineId;
  readonly residency?: Residency;             // default 'worker'

  readonly inputs: readonly FormatId[];
  readonly outputs: readonly FormatId[];

  /**
   * Prunes the inputs x outputs cartesian product. Return false for pairs this
   * converter declares but cannot actually do (e.g. sharp: svg->svg).
   * Omit if the full product is valid.
   */
  supports?(from: FormatId, to: FormatId): boolean;

  /** Per-pair cost. A constant object is fine when the pair doesn't matter. */
  cost(from: FormatId, to: FormatId): EdgeCost;

  /**
   * Cheap, cached, never throws. Called at startup and on manual refresh.
   * Bumps graphVersion when the answer changes.
   */
  availability(): Promise<Availability>;

  /** JSON-schema-ish descriptor so the renderer can auto-render an options form. */
  readonly optionsSchema?: OptionsSchema;
  readonly defaultOptions?: Partial<TOptions>;

  convert(
    input: ConversionInput,
    output: ConversionOutput,
    options: TOptions & CommonOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult>;
}

export interface CommonOptions {
  /** Strip timestamps/producer strings so output is byte-reproducible. Tests set true. */
  deterministic?: boolean;
  /** Preserve EXIF/ID3/XMP where the target supports it. Default true. */
  preserveMetadata?: boolean;
}
```

### Deliberate choices

- **Paths, not buffers, at the boundary.** A 4 GB MKV must never be a `Buffer`. `readBuffer()` exists as an opt-in for pure-JS engines that need it.
- **`onProgress` lives on `ctx`, not as a 4th positional arg.** Progress, cancellation and scratch space are one concern; splitting `onProgress` out while leaving `signal` behind produces converters that can't be cancelled — the single worst failure mode in a batch converter.
- **`cost` is multiplicative retention, not an additive number.** Converters cannot reason about global path cost; they can honestly answer "how much of the thing survives this hop". The router does the math (§2).
- **`inputs x outputs` with a `supports` pruner** beats an explicit pair list: `sharp` declares 14 inputs x 9 outputs = 126 edges in three lines.
- **`residency`** exists because `BrowserWindow.printToPDF` — our html->pdf workhorse — cannot run outside the main process.
- **`availability()` never throws.** A missing binary is a normal state, not an exception. Returning a `remedy` string lets the UI say "install ffmpeg" instead of "unknown error".

### Registry

```ts
export class ConverterRegistry {
  private byId = new Map<ConverterId, Converter>();
  private availability = new Map<ConverterId, Availability>();
  /** Increments whenever availability changes -> invalidates route caches. */
  graphVersion = 0;

  register(c: Converter): void;             // throws on duplicate id or unknown FormatId
  async refreshAvailability(): Promise<void>;
  availableConverters(): Converter[];
}
```

Validate at `register()` time that every declared `FormatId` exists in the format registry. A typo (`'jpg'` instead of `'jpeg'`) must be a startup crash in dev, not a silently unreachable node.

---

## 2. Format graph + routing

### Model

- **Node:** a `FormatId`.
- **Edge:** `{ from, to, converterId, weight }` — parallel edges allowed (multiple converters for jpeg->png); the router keeps only the cheapest per ordered pair, but retains the runner-up as a **fallback** for retry-on-failure.
- Graph is rebuilt from *available* converters only. Unavailable engines simply don't produce edges, so **every route the router returns is executable by construction.**

### Weight function

```ts
const HOP_PENALTY = 1000;

function weight(c: EdgeCost): number {
  // -log turns multiplicative retention into additive distance -> Dijkstra-safe,
  // and correctly models "two 90% hops are worse than one 85% hop".
  const qualityLoss  = -Math.log(clamp(c.retention, 1e-3, 1)) * 300;
  const structLoss   = -Math.log(clamp(c.structure ?? 1, 1e-3, 1)) * 150;
  return HOP_PENALTY + qualityLoss + structLoss + c.effort;
}
```

Properties that fall out of this:
- `HOP_PENALTY = 1000` dominates, so **fewer hops always wins** unless the short path is genuinely destructive (retention < ~0.04).
- A **lossless** hop costs exactly 1000 + effort; a lossy one is strictly more. Lossless paths win ties automatically — no special-casing.
- All weights are strictly positive -> Dijkstra is valid, and negative-cost cycles are impossible.

### Cycle & silliness avoidance

Plain Dijkstra with a settled set already yields simple paths (no repeated node). Two further constraints matter and plain Dijkstra can't express them, so use a **layered graph**: state = `(format, hopCount)`.

```
maxHops default 3, hard ceiling 4.
```

- Layering makes the hop cap exact and keeps the search polynomial (`O(maxHops * (V log V + E))` — with V ~ 170 and E ~ 3000 this is sub-millisecond).
- Additionally forbid **category ping-pong**: once a path leaves category X it may not re-enter it (`image -> document -> image` is never a good idea). Track a small visited-category bitmask in the state key. Categories are <= 12 so the mask is cheap.
- Mark a small set of **hub formats** (`png`, `pdf`, `html`, `wav`, `txt`, `json`, `zip`) with `hub: true`. Converters should be written to route through hubs rather than declaring N^2 direct edges. Hubs are what make `docx -> html -> pdf` and `heic -> png -> ico` emerge for free.

### Algorithm sketch

```ts
export interface Route {
  from: FormatId;
  to: FormatId;
  steps: RouteStep[];        // length 1..maxHops
  totalWeight: number;
  retention: number;         // product of step retentions -> drives the UI "lossless" badge
  lossless: boolean;
}
export interface RouteStep { converterId: ConverterId; from: FormatId; to: FormatId; }

type StateKey = string; // `${format}|${hops}|${catMask}`

export class FormatGraph {
  private out = new Map<FormatId, Edge[]>();

  constructor(converters: Converter[], formats: FormatRegistry) {
    for (const c of converters)
      for (const from of c.inputs)
        for (const to of c.outputs) {
          if (from === to || !(c.supports?.(from, to) ?? true)) continue;
          this.push({ from, to, converterId: c.id, weight: weight(c.cost(from, to)),
                      cost: c.cost(from, to) });
        }
  }

  /**
   * ONE Dijkstra from the source answers BOTH questions:
   *   - "route me to X"          -> routes.get('X')
   *   - "what can X become?"     -> routes.keys()   <- this is the UI's target list
   */
  routesFrom(src: FormatId, opts = { maxHops: 3 }): Map<FormatId, Route> {
    const dist = new Map<StateKey, number>();
    const prev = new Map<StateKey, { key: StateKey; edge: Edge }>();
    const best = new Map<FormatId, { key: StateKey; d: number }>();
    const pq = new MinHeap<{ key: StateKey; fmt: FormatId; hops: number;
                             mask: number; d: number }>((a, b) => a.d - b.d);

    const start = { key: `${src}|0|${catBit(src)}`, fmt: src, hops: 0,
                    mask: catBit(src), d: 0 };
    dist.set(start.key, 0); pq.push(start);

    while (pq.size) {
      const cur = pq.pop()!;
      if (cur.d > (dist.get(cur.key) ?? Infinity)) continue;      // stale entry
      if (cur.hops > 0) {
        const b = best.get(cur.fmt);
        if (!b || cur.d < b.d) best.set(cur.fmt, { key: cur.key, d: cur.d });
      }
      if (cur.hops === opts.maxHops) continue;                     // layer ceiling

      for (const e of this.out.get(cur.fmt) ?? []) {
        const bit = catBit(e.to);
        // no re-entering an abandoned category; no revisiting the source
        if (e.to === src) continue;
        if ((cur.mask & bit) === 0 && leftCategory(cur.mask, bit, e.from)) continue;

        const key = `${e.to}|${cur.hops + 1}|${cur.mask | bit}`;
        const nd  = cur.d + e.weight;
        if (nd < (dist.get(key) ?? Infinity)) {
          dist.set(key, nd);
          prev.set(key, { key: cur.key, edge: e });
          pq.push({ key, fmt: e.to, hops: cur.hops + 1, mask: cur.mask | bit, d: nd });
        }
      }
    }
    return materialize(best, prev);   // walk prev chains -> Route objects
  }
}
```

### Caching & the UI question

```ts
class Router {
  private cache = new Map<string, Map<FormatId, Route>>();  // `${src}|${graphVersion}`

  targetsFor(src: FormatId): FormatId[];                  // single file
  targetsForAll(srcs: FormatId[]): {
    common: FormatId[];                                   // intersection -> enabled
    partial: Map<FormatId, FormatId[]>;                   // -> shown with "12 of 20 files"
  };
}
```

- The renderer asks `warp:targets(formatIds[])` once on selection change. Response is memoised per `graphVersion`, so it is effectively free.
- **Mixed batches:** show the intersection as fully enabled, and formats reachable from *some* inputs as enabled-with-a-count. Never show a target that is reachable from zero selected files.
- Sort the target list by `(category === input.category ? 0 : 1, lossless ? 0 : 1, popularity)` so `png` is the first thing a jpeg user sees.

### Executing a route (temp files between hops)

```ts
async function runRoute(route: Route, inputPath: string, finalPath: string, ctx) {
  const dir = await temp.jobDir(ctx.jobId);              // allocated by MAIN, not the worker
  let cur = inputPath;
  const intermediates: string[] = [];
  try {
    for (const [i, step] of route.steps.entries()) {
      const last = i === route.steps.length - 1;
      const dest = last
        ? await temp.stagingPathBeside(finalPath)        // same volume -> rename, not copy
        : path.join(dir, `hop${i}.${extFor(step.to)}`);
      if (!last) intermediates.push(dest);

      await run(step, cur, dest, {
        ...ctx,
        onProgress: p => ctx.onProgress(scale(p, i, route.steps.length, route.steps)),
      });
      await assertNonEmpty(dest);
      cur = dest;
    }
    await commit(cur, finalPath);                        // rename, EXDEV-fallback to copy
  } finally {
    await rmrf(dir);                                     // intermediates always die
  }
}
```

Per-hop progress is mapped into overall progress using **estimated hop weights** (`effort` normalised across the route), not equal thirds — a `docx->html` hop is instant and `html->pdf` is not; equal-thirds progress bars that stall at 33% look broken.

**Fallback converters:** if a hop fails with a non-user error and a runner-up edge exists for that pair, retry that hop once with the alternate converter before failing the job. Record which converter actually ran.

---

## 3. Format taxonomy

```ts
export type FormatCategory =
  | 'image' | 'audio' | 'video' | 'document' | 'spreadsheet' | 'presentation'
  | 'data'  | 'archive' | 'font' | 'ebook' | 'subtitle' | 'model3d' | 'other';

export interface FormatDef {
  id: FormatId;                       // lowercase, canonical, stable forever
  label: string;                      // 'JPEG Image'
  category: FormatCategory;
  extensions: readonly string[];      // [0] is canonical, used for output naming
  aliases?: readonly string[];        // ids users might type: 'jpg' -> 'jpeg'
  mime: string;
  mimeAliases?: readonly string[];
  binary: boolean;
  lossy: boolean;                     // format is inherently lossy
  animated?: boolean;
  container?: boolean;                // mkv/mp4/zip: holds heterogeneous payloads
  hub?: boolean;
  magic?: readonly MagicSig[];        // { offset, bytes | string, mask? } — also the test oracle
  popularity: 0 | 1 | 2 | 3;          // 3 = show first in UI
  readOnly?: boolean;                 // we can read it, never write it (psd, cr2, rar, doc)
}
```

**Detection order:** magic bytes -> extension -> (text formats) content sniff/parse. When extension and magic disagree, **trust magic** and surface a warning ("this `.jpg` is actually a PNG"). Putting `magic` in the registry means the same table drives detection *and* the integration-test assertions — one source of truth.

### How many formats?

**Target ~165 format ids.** Below ~80 users hit "it doesn't do my file" constantly; above ~200 you're maintaining long-tail engines nobody uses. Ship in three tiers:

- **Tier 1 (~65)** — v1.0. Covers ~95% of real conversions.
- **Tier 2 (~65)** — v1.1-1.3. The long tail people actually hit.
- **Tier 3 (~35)** — opportunistic; each is cheap because a pure-JS lib exists.

### The list

(Formats marked with * are read-only: we can read them, never write them.)

**Image — raster (30)**
`jpeg` (jpg, jpe, jfif) · `png` **hub** · `webp` · `avif` · `heic` · `heif` · `gif` · `bmp` · `tiff` (tif) · `ico` · `jxl` · `tga` · `pnm` (ppm/pgm/pbm) · `apng` · `exr` · `hdr` · `jp2` · `dds` · `psd`* · `xcf`* · `dng`* · `cr2`* · `cr3`* · `nef`* · `arw`* · `orf`* · `rw2`* · `raf`* · `pcx` · `avif-sequence`

**Image — vector (6)**
`svg` · `svgz` · `eps` · `ai`* · `emf` · `wmf`

**Audio (21)**
`mp3` · `wav` **hub** · `flac` · `aac` · `m4a` · `alac` · `ogg` · `opus` · `wma`* · `aiff` · `amr` · `ac3` · `caf` · `au` · `ape`* · `wv` · `mka` · `spx` · `dsf`* · `midi` (mid) · `pcm`

**Video (20)**
`mp4` · `mkv` · `webm` · `mov` · `avi` · `wmv`* · `flv` · `mpeg` (mpg) · `m4v` · `3gp` · `mts` (m2ts/ts) · `ogv` · `asf`* · `vob`* · `mxf` · `y4m` · `prores` · `dv` · `rm`* · `gif-video`

**Document (22)**
`pdf` **hub** · `docx` · `doc`* · `odt` · `rtf` · `txt` **hub** · `md` · `html` **hub** (htm) · `xhtml` · `tex` · `djvu`* · `pages`* · `wpd`* · `abw` · `sxw`* · `ipynb` · `adoc` · `rst` · `org` · `textile` · `mediawiki` · `ps`

**Spreadsheet (7)**
`xlsx` · `xls`* · `ods` · `csv` · `tsv` · `numbers`* · `dif`

**Presentation (5)**
`pptx` · `ppt`* · `odp` · `key`* · `sxi`*

**Data (14)**
`json` **hub** · `jsonl` (ndjson) · `json5` · `yaml` (yml) · `toml` · `xml` · `ini` · `properties` · `plist` · `parquet` · `msgpack` · `cbor` · `bson` · `sql`

**Archive / compression (18)**
`zip` **hub** · `tar` · `tar.gz` (tgz) · `tar.bz2` (tbz2) · `tar.xz` (txz) · `tar.zst` · `gz` · `bz2` · `xz` · `zst` · `lz4` · `br` · `7z` · `rar`* · `cab`* · `iso`* · `dmg`* · `cpio`

**Font (8)**
`ttf` · `otf` · `woff` · `woff2` · `eot` · `ttc` · `type1`* (pfb/pfa) · `svg-font`

**Ebook (8)**
`epub` · `mobi` · `azw3` · `fb2` · `cbz` · `cbr`* · `lit`* · `pdb`*

**Subtitle (6)** — cheap pure-JS wins, disproportionately loved
`srt` · `vtt` · `ass` (ssa) · `sub` · `ttml` · `sbv`

**3D model (8)** — Tier 3
`obj` · `stl` · `ply` · `gltf` · `glb` · `dae` · `3mf` · `fbx`*

**Other (7)** — Tier 3, each ~50 lines with an existing lib
`ics` · `vcf` · `eml` · `msg`* · `bib` · `ris` · `qr` (text -> png)

**Total: 180 ids, ~165 writable.** Trim Tier 3 (3D + other, 15) if scope pressure hits.

### Format-specific notes that will bite you

- `docx -> pdf` **has no good pure-JS direct path.** Route it `docx -> html` (mammoth) `-> pdf` (Chromium `printToPDF`). This is the flagship multi-hop and the reason §2 exists. Do **not** bundle LibreOffice (~400 MB, licensing, per-platform pain); do ship an optional LibreOffice *adapter* whose `availability()` detects a user-installed `soffice` and, when present, offers a higher-fidelity 1-hop edge that the router will naturally prefer.
- `tar.gz` is **one node**, not `tar` + `gz`. Compound archive extensions must be matched longest-first during detection.
- RAW camera formats are read-only and need `libraw`/`dcraw` — Tier 2, gated behind `availability()`.
- `midi` is not audio in the ffmpeg sense; it needs a soundfont to render to `wav`. Ship a small GM soundfont or mark it read-only.

---

## 4. Job execution

### Recommendation: **`utilityProcess` pool**. Not `worker_threads`, not main.

| | main process | worker_threads | **utilityProcess** |
|---|---|---|---|
| Native crash (libvips segfault) | kills the app | **kills the app** | kills one worker |
| OOM on a 2 GB decode | kills the app | kills the app (shared heap) | kills one worker |
| Blocks UI/IPC | yes | no | no |
| Full Node API + `child_process` | yes | yes | yes |
| Killable mid-`ffmpeg` | no | not reliably | **yes, hard kill** |
| Electron lifecycle mgmt | n/a | manual | automatic on quit |

`worker_threads` gets you off the UI thread but **shares the process**: a segfault in a native addon or a V8 OOM takes down File Warper with the user's whole batch. Image and video conversion is exactly where native crashes live. Process isolation is not a nicety here, it's the feature. `utilityProcess` also gives a guaranteed cancel: if a worker ignores its `AbortSignal` for 5 s, `kill()` it and respawn — impossible with a thread.

### Topology

```
+- main process --------------------------------------------+
|  Scheduler (queue, semaphores, temp mgr, name reservation) |
|  MainHopRunner  -- offscreen BrowserWindow x2 (printToPDF) |
+------+---------------------- MessagePort ------------------+
       +-- utilityProcess #1  (converters, ffmpeg children)
       +-- utilityProcess #2
       +-- utilityProcess #N     N = clamp(cpus-1, 1, 4)
```

Per-engine semaphores on top of the global pool limit, because engines lie about their own parallelism:

```ts
const ENGINE_LIMITS = {
  ffmpeg:   2,   // self-threads across all cores; 4 concurrent = thrashing
  sharp:    4,   // libvips already has an internal thread pool; cap it too
  chromium: 2,   // offscreen windows are memory-expensive
  'pure-js': N,
};
```

### Queue

```ts
type JobState = 'queued'|'routing'|'running'|'succeeded'|'failed'|'cancelled'|'skipped';

interface Job {
  id: JobId; batchId: BatchId;
  inputPath: string; inputFormat: FormatId; target: FormatId;
  options: Record<string, unknown>;
  outputPath: string;             // reserved at enqueue time (see §5)
  route?: Route;
  state: JobState;
  progress: number;               // 0..1 overall
  hop: { index: number; total: number } | null;
  error?: ConversionError;
  warnings: string[];
  startedAt?: number; endedAt?: number;
}
```

- FIFO within a batch, round-robin across batches so a 500-file drop doesn't starve a subsequent 1-file drop.
- Routing happens at enqueue (cheap, cached) so the UI can show "no path available" *before* any work starts, and so unroutable files are marked `skipped` immediately.

### Progress over IPC

One channel, batched and throttled:

```ts
// main -> renderer, coalesced, flushed at 10 Hz
type WarpEvent =
  | { t:'batch:created'; batchId; jobs: JobSummary[] }
  | { t:'job:state';     jobId; state: JobState }
  | { t:'job:progress';  jobId; progress: number; hop: {index;total}; eta?: number }
  | { t:'job:done';      jobId; outputPath: string; bytes: number; warnings: string[] }
  | { t:'job:error';     jobId; error: SerializedError }
  | { t:'batch:done';    batchId; ok: number; failed: number; skipped: number };

webContents.send('warp:events', WarpEvent[]);   // always an array
```

**Throttle hard.** A 500-file batch with per-hop progress trivially emits 50k events/sec; unthrottled, IPC serialization becomes the bottleneck and the UI drops frames. Coalesce per `jobId` (keep only the latest `job:progress`), flush every 100 ms. State transitions are never dropped, only progress is.

Commands go the other way via `invoke`:

```ts
warp:probe(paths[])            -> { path, format, confidence, warnings }[]
warp:targets(formatIds[])      -> { common: FormatId[]; partial: Record<...> }
warp:enqueue(request)          -> { batchId, jobs: JobSummary[] }
warp:cancelJob(jobId)          -> void
warp:cancelBatch(batchId)      -> void
warp:availability()            -> Record<ConverterId, Availability>
```

Expose exactly this surface through `contextBridge` — `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`. The renderer never touches `fs`.

### Cancellation

Three-stage, no exceptions:
1. Main aborts the job's `AbortController`, sends `{cancel, jobId}` to the owning worker.
2. Worker's `ctx.signal` fires. Converters `await`-race it; the ffmpeg adapter sends `SIGTERM` to its child, then `SIGKILL` after 3 s.
3. No ack within 5 s -> main `kill()`s the whole utilityProcess and respawns it. Any *other* jobs on that worker are requeued (they were innocent).

Cancelled jobs clean their temp dir and delete any partially-written staging file. **A cancelled conversion must never leave a truncated file at the output path** — this is why the last hop writes to a staging path and only `rename`s on success.

### Error isolation

- Every job body is wrapped; a throw marks that job `failed` and the loop continues. There is no path from one job's failure to another's.
- Worker death -> in-flight jobs on it are marked `failed` with `E_WORKER_CRASH`, worker respawns, and each such job is retried **once**.
- Structured errors, because "Error: spawn ENOENT" is not a UI string:

```ts
class ConversionError extends Error {
  code: 'E_NO_ROUTE'|'E_UNAVAILABLE'|'E_CORRUPT_INPUT'|'E_UNSUPPORTED_FEATURE'
      | 'E_DISK_FULL'|'E_PERMISSION'|'E_TIMEOUT'|'E_CANCELLED'|'E_WORKER_CRASH'|'E_ENGINE';
  userMessage: string;          // shown in the UI
  detail?: string;              // engine stderr, shown behind "Details"
  step?: RouteStep;             // which hop died
  retryable: boolean;
}
```

- Per-job wall-clock timeout, scaled by input size (`60s + size/1MB * 2s`, min 60 s, max 30 min) -> `E_TIMEOUT` rather than a hung batch.
- Batch summary at the end with a "retry failed only" action.

---

## 5. Temp files and output

### Temp layout

```
{app.getPath('temp')}/file-warper/
  s-{pid}-{startedAtMs}/          <- session root, one per app run
    job-{jobId}/                  <- hop intermediates + engine scratch
```

**Main allocates and owns every temp dir**, not the worker. If a worker dies, main still holds the path and can clean it — a worker-owned dir leaks forever on crash.

### Cleanup guarantees (all four, they're each cheap)

1. `try/finally` per job -> `rm(jobDir, {recursive:true, force:true})`.
2. `app.on('will-quit')` -> remove the session root.
3. `process.on('exit')` -> best-effort `rmSync` (sync is required here; async never runs).
4. **Startup sweep**: scan `file-warper/s-*`, delete any whose `pid` is dead (`process.kill(pid, 0)` throws) or whose `startedAt` is > 24 h old. This is the one that actually saves you, because 1-3 all lose to `SIGKILL`.

### Disk guard

Before a batch, estimate `sum(inputSize) * routeFactor` (1.5x images, 3x video transcode, 10x raw/uncompressed targets) and check free space on both temp and output volumes. Fail fast with `E_DISK_FULL` rather than dying at 90% through file 400.

### Staging + atomic commit

The **final** hop writes to `{outputDir}/.filewarper-{rand}.tmp`, i.e. the *output* volume, then `fs.rename` onto the real path.
- `rename` on the same volume is atomic -> no partial file is ever visible at the destination.
- Writing the last hop into `os.tmpdir()` and copying costs a full extra read+write of the largest artifact, and `os.tmpdir()` is often a small `tmpfs`.
- Handle `EXDEV` by falling back to copy + `unlink`.
- Sweep stale `.filewarper-*.tmp` in output dirs we wrote to, at batch end.

### Output naming

Default: `{inputBasename}.{canonicalExt}` in `dirname(inputPath)`.

```ts
type CollisionPolicy = 'suffix' | 'overwrite' | 'skip' | 'timestamp';   // default 'suffix'
```

- `suffix` -> `photo.png`, `photo (1).png`, `photo (2).png` (matches Finder; users recognise it).
- `timestamp` -> `photo-20260825-141233.png`.
- **Reserve names in memory at enqueue time**, in a `Set` checked alongside the filesystem. Two inputs (`a.heic`, `a.png`) converging on `a.jpeg`, or two concurrent jobs racing, will both pass a naive `existsSync` check and one silently clobbers the other. The reservation set is the fix.
- Case-insensitive filesystems (default on macOS): compare reservations lowercased on `darwin`/`win32`.
- Sanitize: strip `<>:"/\|?*` and control chars, trim trailing dots/spaces, reject reserved device names (`CON`, `NUL`, `LPT1`...), clamp to 255 **bytes** (not chars).
- **If the computed output path equals the input path, force `suffix` regardless of policy.** Never destroy the source.
- Preserve the source file's mtime onto the output when `preserveMetadata` is on.

### Output location

```ts
type OutputLocation =
  | { mode: 'alongside' }                                 // DEFAULT
  | { mode: 'fixed'; dir: string }
  | { mode: 'mirror'; root: string; sourceRoot: string }; // folder drops keep tree shape
```

`mirror` matters as soon as you support dropping a folder — flattening 300 files from 40 subfolders into one directory is a collision storm and a UX disaster. Persist the last choice per-session, offer "always use this folder" in settings.

---

## 6. Testing strategy

Four layers, ordered by how often they run.

### Layer 1 — graph unit tests (vitest, milliseconds, no fixtures at all)

The router is pure. Test it with **synthetic converters** declared inline — never with real engines.

```ts
const g = graphOf([
  fake('a', ['x'], ['y'], { retention: 0.8 }),
  fake('b', ['x'], ['z'], { retention: 1.0 }),
  fake('c', ['z'], ['y'], { retention: 1.0 }),
]);
// HOP_PENALTY dominates -> the single lossy hop wins over two lossless hops.
expect(g.routesFrom('x').get('y')!.steps.map(s => s.converterId)).toEqual(['a']);
```

Cases to cover: 1-hop preferred over 2-hop; lossless preferred at equal hop count; `maxHops` respected; unavailable converter excluded; no cycles in any returned route; deterministic tie-break (sort by converter id); parallel edges pick the cheaper; category ping-pong rejected; reachability set == BFS closure under the hop cap.

**Property test with `fast-check`:** generate random graphs of <= 12 nodes / <= 25 edges, and assert Dijkstra's cost equals brute-force enumeration of all simple paths <= maxHops. This catches layered-state bugs that hand-written cases never will, and it runs in under a second.

### Layer 2 — registry invariants (zero fixtures, zero engines, runs on every commit)

Pure data assertions that catch 80% of real regressions:

- Every `FormatId` referenced by any converter exists in the format registry.
- `ConverterId`s and `FormatId`s are unique; aliases don't collide with ids.
- Every extension maps to exactly one format (or is explicitly listed as shared).
- Every binary format has at least one `magic` signature.
- Every non-`readOnly` format has >= 1 in-edge; every format has >= 1 out-edge (or is explicitly terminal).
- **Snapshot the reachability matrix.** Serialize `for each format: sorted(reachable targets)` to a committed snapshot file. Any converter change produces a reviewable diff showing exactly which conversions appeared or disappeared. This single test is the highest-value one in the suite.

### Layer 3 — per-converter integration (tagged `@heavy`, sharded by engine)

For **every registered converter x every supported (from, to) pair**: run it on a tiny fixture, assert the output is a valid file of the target format.

```ts
describe.each(allConverterPairs())('$converterId: $from -> $to', ({ conv, from, to }) => {
  it('produces a valid file', async () => {
    if (!(await conv.availability()).available) return ctx.skip();
    const input = await fixtures.get(from);          // generated, cached
    const out   = tmp.file(to);
    await conv.convert(input, { path: out, format: to }, {}, testCtx());
    await assertIsFormat(out, to);                   // magic bytes from the SAME registry
    await deepValidate(out, to);                     // category-specific, below
  });
});
```

- `assertIsFormat` reads `FormatDef.magic` — the registry is thereby exercised by the test rather than duplicated in it.
- **Deep validators** per category, because magic bytes only prove the header:
  - image -> `sharp(out).metadata()` reports the expected `format` and non-zero dims
  - audio/video -> `ffprobe -show_streams -of json` reports the expected codec/container
  - pdf -> starts `%PDF-`, ends `%%EOF`, `PDFDocument.load()` reports >= 1 page
  - OOXML/epub/cbz -> `jszip.loadAsync` succeeds and contains the required entries (`[Content_Types].xml`, `mimetype`, ...)
  - text/data -> parse with the target's own parser (`JSON.parse`, `yaml.parse`, `csv-parse`)
  - font -> `opentype.js` parse, `numGlyphs > 0`
- Budget: **each case < 2 s**. If a case is slower, the fixture is too big.

### Layer 4 — route round-trips (small, high signal)

For every pair marked lossless in both directions (`png<->bmp`, `wav<->flac`, `json<->yaml`, `zip<->tar`), assert `a -> b -> a` reproduces the original semantically (decoded pixel buffers equal / parsed objects deep-equal). Also assert a handful of known multi-hop routes end-to-end: `docx -> pdf`, `heic -> ico`, `csv -> xlsx -> csv`.

### Generating tiny fixtures programmatically

**Rule: synthesize whenever a library can; check in a binary only when synthesis is genuinely impossible.** Target < 2 KB per fixture.

```ts
// test/fixtures/generators.ts — one function per format, memoized on disk.
export const generators: Record<FormatId, () => Promise<Buffer>> = {
  // 2x2 raw RGB -> sharp encodes to png/jpeg/webp/avif/tiff/gif/heic/jxl/...
  png:  () => sharp(Buffer.from([255,0,0, 0,255,0, 0,0,255, 255,255,0]),
                    { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer(),
  jpeg: () => rasterFrom('jpeg'),   // same 2x2 source, different encoder

  // 50 ms 440 Hz sine, then let ffmpeg re-encode into every audio format
  wav:  () => Promise.resolve(pcmWav(440, 0.05)),        // ~50 lines, zero deps
  mp3:  () => ffmpegFrom('wav', 'mp3'),

  // 16x16, 3 frames — smallest thing every codec accepts
  mp4:  () => ffmpegLavfi('testsrc=size=16x16:rate=3:duration=0.1', 'mp4'),

  txt: () => buf('hello warp\n'),
  csv: () => buf('a,b\n1,2\n'),
  json: () => buf('{"a":1}'),
  svg: () => buf('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'),
  html: () => buf('<!doctype html><title>t</title><p>hi'),

  pdf:  async () => { const d = await PDFDocument.create(); d.addPage([72,72]);
                      return Buffer.from(await d.save()); },
  docx: () => new Packer().toBuffer(minimalDocx()),      // `docx` pkg
  xlsx: () => minimalWorkbook().xlsx.writeBuffer(),      // `exceljs`
  zip:  () => new JSZip().file('a.txt','hi').generateAsync({type:'nodebuffer'}),
  'tar.gz': () => tarGzOf({ 'a.txt': 'hi' }),
};
```

- **Cascade generation:** `wav` is hand-built (a 44-byte header + 100 samples, no dependency), then every other audio format is `ffmpeg`-derived from it. Same for `png -> everything raster` and `pdf -> ps`. You hand-write maybe 12 generators; the other 150 fall out.
- **Cache** to `node_modules/.cache/warp-fixtures/{formatId}-{hash(generatorSource)}.bin`.
- **Determinism:** every generator runs with `deterministic: true` (fixed PDF `CreationDate`, zip mtime `0`, no producer strings) so snapshot comparisons are stable across machines and dates.
- **Checked-in exceptions** (`test/fixtures/binary/`, hard cap 4 KB each, each with a `README` line explaining why): a single-glyph subsetted `.ttf`, one tiny `.dng` and one `.cr2`, one `.psd`, one `.rar`, one `.doc`. Roughly six files, ~15 KB total.
- **Availability faking:** unit-test `availability()` implementations against a stubbed `PATH`, so "ffmpeg missing -> edges removed -> route falls back to pure-JS" is tested without uninstalling anything.

---

## 7. Decision summary

| Decision | Choice | Why |
|---|---|---|
| Converter granularity | one plugin per engine, `inputs x outputs` + `supports()` pruner | 3 lines declares 126 edges |
| Data at the boundary | file paths, opt-in `readBuffer()` | 4 GB video must not be a Buffer |
| Cost model | multiplicative retention, `-log` into additive weight | Dijkstra-valid, models chained loss correctly |
| Hop preference | `HOP_PENALTY = 1000` dominates quality terms | fewer hops unless the short path is destructive |
| Path search | layered Dijkstra on `(format, hops, categoryMask)` | exact hop cap + no ping-pong, still sub-ms |
| Reachable targets | one Dijkstra per source, memoized on `graphVersion` | same run answers routing *and* the UI's target list |
| Format count | ~165 writable / 180 ids, three tiers | below 80 feels broken, above 200 is unmaintainable |
| `docx -> pdf` | `docx -> html -> pdf` via Chromium; optional LibreOffice adapter | no 400 MB bundle, better path used when available |
| Execution | `utilityProcess` pool, N = `clamp(cpus-1, 1, 4)` | native crashes and OOM kill one worker, not the app |
| Main-resident hops | `residency: 'main'` for `printToPDF`, 2 offscreen windows | `BrowserWindow` cannot live in a utility process |
| Progress IPC | one channel, coalesced per job, flushed at 10 Hz | 500 files x per-hop progress will otherwise saturate IPC |
| Cancel | AbortSignal -> SIGTERM -> SIGKILL -> kill the worker | guaranteed, which threads cannot offer |
| Temp ownership | main allocates every temp dir | worker crash still leaves a cleanable path |
| Final write | staging file on the **output** volume + `rename` | atomic, no partial files, no extra full copy |
| Collisions | `suffix` default, in-memory reservation set + FS check | `existsSync` alone races and silently clobbers |
| Testing | pure-graph units + committed reachability snapshot + generated <=2 KB fixtures | the snapshot diff is the highest-signal test in the repo |

**Build order:** `@warp/core` (formats + graph + tests, no engines) -> runtime skeleton with a fake converter -> sharp + ffmpeg -> Chromium PDF + the document chain -> long tail.
