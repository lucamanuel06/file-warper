import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let fakeUserData: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? fakeUserData : '/tmp'),
  },
}));

async function freshSettings(): Promise<typeof import('./settings')> {
  vi.resetModules();
  return import('./settings');
}

function settingsFilePath(): string {
  return path.join(fakeUserData, 'settings.json');
}

describe('settings', () => {
  let settings: typeof import('./settings');

  beforeEach(async () => {
    fakeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-settings-'));
    settings = await freshSettings();
  });

  afterEach(() => {
    fs.rmSync(fakeUserData, { recursive: true, force: true });
  });

  it('load() returns defaults when the file is missing', () => {
    const result = settings.load();
    expect(result).toEqual({
      theme: 'system',
      outputMode: 'alongside',
      outputDir: null,
      collision: 'suffix',
      preserveMetadata: true,
      revealWhenDone: false,
      checkForUpdates: true,
    });
  });

  it('load() merges a partial file over the defaults', () => {
    fs.writeFileSync(
      settingsFilePath(),
      JSON.stringify({ theme: 'dark', revealWhenDone: true }),
    );
    const result = settings.load();
    expect(result.theme).toBe('dark');
    expect(result.revealWhenDone).toBe(true);
    // untouched fields keep their defaults
    expect(result.collision).toBe('suffix');
    expect(result.preserveMetadata).toBe(true);
  });

  it('load() falls back to defaults without throwing on corrupt JSON', () => {
    fs.writeFileSync(settingsFilePath(), '{ this is not json');
    expect(() => settings.load()).not.toThrow();
    expect(settings.load()).toEqual(settings.get());
    expect(settings.get().theme).toBe('system');
  });

  it('load() replaces an invalid theme with the default', () => {
    fs.writeFileSync(settingsFilePath(), JSON.stringify({ theme: 'ultraviolet' }));
    expect(settings.load().theme).toBe('system');
  });

  it('load() replaces an invalid collision policy with the default', () => {
    fs.writeFileSync(settingsFilePath(), JSON.stringify({ collision: 'nuke-it' }));
    expect(settings.load().collision).toBe('suffix');
  });

  it('load() drops unknown keys', () => {
    fs.writeFileSync(
      settingsFilePath(),
      JSON.stringify({ theme: 'dark', totallyMadeUpField: 42 }),
    );
    const result = settings.load() as unknown as Record<string, unknown>;
    expect(result.totallyMadeUpField).toBeUndefined();
  });

  it('load() resets outputDir to null and outputMode to alongside when the dir does not exist', () => {
    fs.writeFileSync(
      settingsFilePath(),
      JSON.stringify({ outputMode: 'fixed', outputDir: '/definitely/not/a/real/path' }),
    );
    const result = settings.load();
    expect(result.outputDir).toBeNull();
    expect(result.outputMode).toBe('alongside');
  });

  it('load() keeps a valid, existing outputDir with fixed mode', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-output-'));
    try {
      fs.writeFileSync(
        settingsFilePath(),
        JSON.stringify({ outputMode: 'fixed', outputDir: realDir }),
      );
      const result = settings.load();
      expect(result.outputDir).toBe(realDir);
      expect(result.outputMode).toBe('fixed');
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });

  it('patch() merges, persists, and returns the full merged result', () => {
    settings.load();
    const result = settings.patch({ theme: 'dark', preserveMetadata: false });
    expect(result.theme).toBe('dark');
    expect(result.preserveMetadata).toBe(false);
    // other defaults preserved
    expect(result.collision).toBe('suffix');

    const onDisk = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'));
    expect(onDisk.theme).toBe('dark');
    expect(onDisk.preserveMetadata).toBe(false);
  });

  it('patch() validates its input the same way load() does', () => {
    settings.load();
    const result = settings.patch({ theme: 'not-a-theme' as never });
    expect(result.theme).toBe('system');
  });

  it('get() returns the last loaded/patched value', () => {
    settings.load();
    settings.patch({ theme: 'dark' });
    expect(settings.get().theme).toBe('dark');
  });

  it('onChange() fires with the new settings on patch()', () => {
    settings.load();
    const listener = vi.fn();
    const dispose = settings.onChange(listener);
    settings.patch({ theme: 'light' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }));
    dispose();
    settings.patch({ theme: 'dark' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
