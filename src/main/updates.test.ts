import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let fakeUserData: string;
let appVersion = '1.2.3';
const fetchMock = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? fakeUserData : '/tmp'),
    getVersion: () => appVersion,
  },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) },
}));

vi.mock('./settings', () => ({
  get: vi.fn(() => ({ checkForUpdates: true })),
}));

async function freshUpdates(): Promise<typeof import('./updates')> {
  vi.resetModules();
  return import('./updates');
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('updates', () => {
  let updates: typeof import('./updates');
  let settingsMock: typeof import('./settings');

  beforeEach(async () => {
    fakeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-update-state-'));
    appVersion = '1.2.3';
    fetchMock.mockReset();
    updates = await freshUpdates();
    settingsMock = await import('./settings');
    vi.mocked(settingsMock.get).mockReturnValue({ checkForUpdates: true } as never);
  });

  afterEach(() => {
    fs.rmSync(fakeUserData, { recursive: true, force: true });
  });

  describe('compareVersions', () => {
    it.each([
      ['1.9.0', '1.10.0', -1],
      ['1.10.0', '1.9.0', 1],
      ['1.0.0', '1.0.0', 0],
      ['2.0.0', '1.99.99', 1],
      ['v1.2.0', '1.1.0', 1],
      ['1.2.0', 'v1.2.0', 0],
    ])('compareVersions(%s, %s) is %s', (a, b, expected) => {
      const result = updates.compareVersions(a, b);
      if (expected === 0) expect(result).toBe(0);
      else if (expected < 0) expect(result).toBeLessThan(0);
      else expect(result).toBeGreaterThan(0);
    });
  });

  describe('pickAssetUrl', () => {
    // The exact asset set a real release ships — this is what v1.3.1 has.
    const RELEASE = {
      assets: [
        'file-warper_1.3.1_amd64.deb',
        'File.Warper-1.3.1-arm64-mac.zip',
        'File.Warper-1.3.1-arm64.dmg',
        'File.Warper-1.3.1-mac.zip',
        'File.Warper-1.3.1-x64-portable.exe',
        'File.Warper-1.3.1-x64-setup.exe',
        'File.Warper-1.3.1-x86_64.AppImage',
        'File.Warper-1.3.1.dmg',
      ].map((name) => ({
        name,
        browser_download_url: `https://github.com/o/r/releases/download/v1.3.1/${name}`,
      })),
    };

    const nameFor = (platform: string, arch: string) =>
      updates.pickAssetUrl(RELEASE, platform, arch)?.split('/').pop() ?? null;

    it.each([
      // The bug this replaces: every one of these used to get a .dmg.
      ['win32', 'x64', 'File.Warper-1.3.1-x64-setup.exe'],
      ['linux', 'x64', 'File.Warper-1.3.1-x86_64.AppImage'],
      // ...and an Intel Mac used to get whichever dmg GitHub listed first.
      ['darwin', 'x64', 'File.Warper-1.3.1.dmg'],
      ['darwin', 'arm64', 'File.Warper-1.3.1-arm64.dmg'],
    ])('%s/%s gets %s', (platform, arch, expected) => {
      expect(nameFor(platform, arch)).toBe(expected);
    });

    it('prefers the installer over the portable build', () => {
      expect(nameFor('win32', 'x64')).toContain('setup');
    });

    it('never hands a machine a build for another architecture', () => {
      // No arm64 Windows or Linux asset exists in this release, and an x64
      // binary will not run there — the release page is the honest answer.
      expect(nameFor('win32', 'arm64')).toBeNull();
      expect(nameFor('linux', 'arm64')).toBeNull();
    });

    it('does not read x86_64 as the 32-bit x86', () => {
      // `x86` is a substring of `x86_64`; a naive match makes every Intel
      // build look like an ia32 one (and hides it from x64 machines).
      expect(nameFor('linux', 'ia32')).toBeNull();
      expect(nameFor('linux', 'x64')).toBe('File.Warper-1.3.1-x86_64.AppImage');
    });

    it('falls back to the mac .zip only when there is no .dmg', () => {
      const zipOnly = {
        assets: RELEASE.assets.filter((a) => !a.name.endsWith('.dmg')),
      };
      expect(updates.pickAssetUrl(zipOnly, 'darwin', 'arm64')).toContain('arm64-mac.zip');
    });

    it('ignores a source archive that is not one of our builds', () => {
      const sourceOnly = {
        assets: [
          { name: 'source.zip', browser_download_url: 'https://github.com/x/source.zip' },
          { name: 'checksums.txt', browser_download_url: 'https://github.com/x/c.txt' },
        ],
      };
      for (const platform of ['darwin', 'win32', 'linux']) {
        expect(updates.pickAssetUrl(sourceOnly, platform, 'x64')).toBeNull();
      }
    });

    it('returns null for a release with no assets, and for an unknown platform', () => {
      expect(updates.pickAssetUrl({ assets: [] }, 'darwin', 'arm64')).toBeNull();
      expect(updates.pickAssetUrl({}, 'darwin', 'arm64')).toBeNull();
      expect(updates.pickAssetUrl(RELEASE, 'freebsd', 'x64')).toBeNull();
    });
  });

  it('carries the platform-matched asset into the available status', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        tag_name: 'v9.9.9',
        html_url: 'https://github.com/owner/repo/releases/tag/v9.9.9',
        body: 'notes',
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          {
            name: 'checksums.txt',
            browser_download_url: 'https://github.com/x/checksums.txt',
          },
          {
            name: `FileWarper-${process.arch}.dmg`,
            browser_download_url: 'https://github.com/x/mac.dmg',
          },
          {
            name: 'FileWarper-setup.exe',
            browser_download_url: 'https://github.com/x/win.exe',
          },
        ],
      }),
    );
    const status = await updates.checkForUpdates({ manual: true });
    expect(status.state).toBe('available');
    if (status.state === 'available') {
      expect(status.latest).toBe('9.9.9');
      const expected =
        process.platform === 'darwin'
          ? 'https://github.com/x/mac.dmg'
          : process.platform === 'win32'
            ? 'https://github.com/x/win.exe'
            : null;
      expect(status.downloadUrl).toBe(expected);
    }
  });

  it('returns null downloadUrl when no asset fits this machine', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        tag_name: 'v9.9.9',
        html_url: 'https://github.com/owner/repo/releases/tag/v9.9.9',
        assets: [
          { name: 'source.zip', browser_download_url: 'https://github.com/x/source.zip' },
        ],
      }),
    );
    const status = await updates.checkForUpdates({ manual: true });
    expect(status.state).toBe('available');
    if (status.state === 'available') expect(status.downloadUrl).toBeNull();
  });

  it('a 404 response becomes a friendly error state', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 404));
    const status = await updates.checkForUpdates({ manual: true });
    expect(status.state).toBe('error');
    if (status.state === 'error') expect(status.message).not.toMatch(/404|ENOTFOUND/);
  });

  it('a timeout/abort becomes a friendly error state', async () => {
    fetchMock.mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );
    const status = await updates.checkForUpdates({ manual: true });
    expect(status.state).toBe('error');
    if (status.state === 'error') expect(status.message).not.toMatch(/Abort/);
  });

  it('a malformed JSON body becomes a friendly error state', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    const status = await updates.checkForUpdates({ manual: true });
    expect(status.state).toBe('error');
    if (status.state === 'error')
      expect(status.message).not.toMatch(/SyntaxError|Unexpected/);
  });

  it('makes no fetch call when checkForUpdates is disabled and the check is automatic', async () => {
    vi.mocked(settingsMock.get).mockReturnValue({ checkForUpdates: false } as never);
    const status = await updates.checkForUpdates({ manual: false });
    expect(status).toEqual({ state: 'idle' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('manual: true bypasses the checkForUpdates setting', async () => {
    vi.mocked(settingsMock.get).mockReturnValue({ checkForUpdates: false } as never);
    fetchMock.mockResolvedValue(jsonResponse({ tag_name: '0.0.1', assets: [] }));
    const status = await updates.checkForUpdates({ manual: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status.state).toBe('current');
  });

  it('throttles a second automatic check, but manual gets through', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tag_name: '0.0.1', assets: [] }));

    const first = await updates.checkForUpdates({ manual: false });
    expect(first.state).toBe('current');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await updates.checkForUpdates({ manual: false });
    expect(second).toEqual({ state: 'idle' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const manual = await updates.checkForUpdates({ manual: true });
    expect(manual.state).toBe('current');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves to "current" when the tag equals the current app version', async () => {
    appVersion = '1.0.0';
    fetchMock.mockResolvedValue(jsonResponse({ tag_name: 'v1.0.0', assets: [] }));
    const status = await updates.checkForUpdates({ manual: true });
    expect(status.state).toBe('current');
  });
});
