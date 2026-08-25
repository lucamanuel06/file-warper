/**
 * `node-7z` ships no type declarations (and there is no `@types/node-7z`).
 * This is a minimal ambient declaration covering the slice of its API this
 * directory actually calls — commands return an event-emitting stream that
 * wraps a spawned `7za` child process.
 */
declare module 'node-7z' {
  import type { ChildProcess } from 'node:child_process';
  import type { Readable } from 'node:stream';

  export interface SevenZipOptions {
    readonly $bin?: string;
    readonly $progress?: boolean;
    readonly $cherryPick?: string | readonly string[];
    readonly $defer?: boolean;
    readonly $childProcess?: ChildProcess;
    readonly recursive?: boolean;
    readonly archiveType?: string;
    readonly outputDir?: string;
    readonly password?: string;
    readonly [switchName: string]: unknown;
  }

  export interface SevenZipDataEvent {
    readonly file?: string;
    readonly status?: string;
    readonly attributes?: string;
    readonly size?: number;
    readonly sizeCompressed?: number;
    readonly techInfo?: Map<string, string>;
    readonly [key: string]: unknown;
  }

  export interface SevenZipProgressEvent {
    readonly percent?: number;
    readonly fileCount?: number;
    readonly file?: string;
  }

  export interface SevenZipStream extends Readable {
    readonly info: Map<string, string>;
    /** Present once the child process has been spawned; not officially documented. */
    _childProcess?: ChildProcess;
    on(event: 'data', listener: (data: SevenZipDataEvent) => void): this;
    on(event: 'progress', listener: (progress: SevenZipProgressEvent) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export function add(
    archive: string,
    source: string | readonly string[],
    options?: SevenZipOptions,
  ): SevenZipStream;
  export function extract(
    archive: string,
    output: string,
    options?: SevenZipOptions,
  ): SevenZipStream;
  export function extractFull(
    archive: string,
    output: string,
    options?: SevenZipOptions,
  ): SevenZipStream;
  export function list(archive: string, options?: SevenZipOptions): SevenZipStream;
  export function test(archive: string, options?: SevenZipOptions): SevenZipStream;
  export function rename(
    archive: string,
    target: ReadonlyArray<readonly [string, string]>,
    options?: SevenZipOptions,
  ): SevenZipStream;
}
