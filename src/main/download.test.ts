import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UpdateDownloadProgress } from '@shared/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    getVersion: () => '1.3.1',
  },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) },
}));

const ASSET = (name: string) =>
  `https://github.com/lucamanuel06/file-warper/releases/download/v9.9.9/${name}`;

/** A minimal stand-in for the WHATWG Response `net.fetch` hands back. */
function streamResponse(
  chunks: readonly Uint8Array[],
  opts: { contentLength?: number | null; ok?: boolean; stall?: boolean } = {},
) {
  const declared =
    opts.contentLength === undefined
      ? chunks.reduce((n, c) => n + c.byteLength, 0)
      : opts.contentLength;

  let i = 0;
  return {
    ok: opts.ok ?? true,
    headers: { get: () => (declared === null ? null : String(declared)) },
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) return { done: false, value: chunks[i++] };
          // `stall` keeps the stream open forever, and deliberately ignores the
          // abort signal: cancelling must work even against a stream that does
          // not cooperate.
          if (opts.stall) await new Promise(() => {});
          return { done: true, value: undefined };
        },
        cancel: async () => {},
      }),
    },
  };
}

const chunk = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe('downloadUpdate', () => {
  let dir: string;
  let frames: UpdateDownloadProgress[];
  let download: typeof import('./download');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-download-'));
    frames = [];
    fetchMock.mockReset();
    vi.resetModules();
    download = await import('./download');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (url: string) =>
    download.downloadUpdate(url, {
      downloadsDir: dir,
      onProgress: (p) => frames.push(p),
    });

  describe('isReleaseAssetUrl', () => {
    it.each([
      [ASSET('File.Warper-1.3.1-arm64.dmg'), true],
      ['https://github.com/lucamanuel06/file-warper/releases/latest', false],
      // Another repo's release assets are still github.com — the hostname
      // check alone is not enough.
      ['https://github.com/someone/else/releases/download/v1/evil.dmg', false],
      ['http://github.com/lucamanuel06/file-warper/releases/download/v1/a.dmg', false],
      ['https://evil.com/lucamanuel06/file-warper/releases/download/v1/a.dmg', false],
      ['not a url', false],
    ])('%s -> %s', (url, expected) => {
      expect(download.isReleaseAssetUrl(url)).toBe(expected);
    });
  });

  it('refuses a URL outside this project’s releases', async () => {
    await expect(
      run('https://github.com/someone/else/releases/download/v1/x.dmg'),
    ).rejects.toThrow(/not a File Warper release/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes the asset, reports progress, and resolves with the path', async () => {
    fetchMock.mockResolvedValue(streamResponse([chunk(100), chunk(150)]));

    const out = await run(ASSET('File.Warper-1.3.1-arm64.dmg'));

    expect(out).toBe(path.join(dir, 'File.Warper-1.3.1-arm64.dmg'));
    expect(fs.statSync(out).size).toBe(250);
    // The staging file must never survive.
    expect(fs.existsSync(`${out}.part`)).toBe(false);

    const last = frames.at(-1);
    expect(last).toMatchObject({ state: 'done', received: 250, total: 250, path: out });
  });

  it('reports an indeterminate ratio when the server sends no Content-Length', async () => {
    fetchMock.mockResolvedValue(streamResponse([chunk(64)], { contentLength: null }));

    await run(ASSET('File.Warper.dmg'));

    // -1, not 0 — the UI shows a sweep instead of a bar stuck at 0%.
    expect(frames.some((f) => f.state === 'downloading' && f.ratio === -1)).toBe(true);
  });

  it('fails on a truncated body instead of leaving a corrupt installer', async () => {
    // Server promised 1000 bytes and closed the stream after 100.
    fetchMock.mockResolvedValue(streamResponse([chunk(100)], { contentLength: 1000 }));

    await expect(run(ASSET('File.Warper.dmg'))).rejects.toThrow(/download stopped/i);

    expect(fs.readdirSync(dir)).toEqual([]);
    expect(frames.at(-1)?.state).toBe('error');
  });

  it('turns a non-ok response into a readable error and writes nothing', async () => {
    fetchMock.mockResolvedValue(streamResponse([], { ok: false }));

    await expect(run(ASSET('File.Warper.dmg'))).rejects.toThrow(/download stopped/i);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('never overwrites a file already in Downloads', async () => {
    fs.writeFileSync(path.join(dir, 'File.Warper.dmg'), 'previous download');
    fetchMock.mockResolvedValue(streamResponse([chunk(10)]));

    const out = await run(ASSET('File.Warper.dmg'));

    expect(path.basename(out)).toBe('File.Warper (1).dmg');
    expect(fs.readFileSync(path.join(dir, 'File.Warper.dmg'), 'utf8')).toBe(
      'previous download',
    );
  });

  it('cancelling stops the download and removes the partial file', async () => {
    fetchMock.mockResolvedValue(streamResponse([chunk(10)], { stall: true }));

    const pending = run(ASSET('File.Warper.dmg'));
    // Let the first chunk land so there is a real .part file to clean up.
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    download.cancelDownload();

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(frames.at(-1)?.state).toBe('cancelled');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(download.isDownloading()).toBe(false);
  });
});
