import { describe, expect, it } from 'vitest';
import { osFolder, sidecarPath } from './resolveBinary';

/**
 * These paths are the seam between three places that must agree:
 *   scripts/vendor-binaries.mjs  (writes them)
 *   electron-builder.yml         (`extraResources: resources/bin/${os}/${arch}`)
 *   this module                  (reads them at runtime)
 * A mismatch shows up only as "Missing sidecar binary" at runtime, on one
 * platform, so pin it here.
 */
describe('osFolder', () => {
  it("uses electron-builder's vocabulary, not process.platform's", () => {
    expect(osFolder('darwin')).toBe('mac');
    expect(osFolder('win32')).toBe('win');
    expect(osFolder('linux')).toBe('linux');
  });

  it('treats any other unix as linux rather than inventing a folder', () => {
    expect(osFolder('freebsd' as NodeJS.Platform)).toBe('linux');
  });
});

describe('sidecarPath', () => {
  const packagedOpts = (platform: NodeJS.Platform) => ({
    packaged: true,
    platform,
    arch: 'x64',
    resourcesPath: '/app/Resources',
    appPath: '/app',
  });

  it('resolves flat under resourcesPath when packaged', () => {
    expect(sidecarPath('ffmpeg', packagedOpts('darwin'))).toBe(
      '/app/Resources/bin/ffmpeg',
    );
  });

  it('appends .exe on Windows, and only on Windows', () => {
    expect(sidecarPath('ffprobe', packagedOpts('win32'))).toBe(
      '/app/Resources/bin/ffprobe.exe',
    );
    expect(sidecarPath('ffprobe', packagedOpts('linux'))).toBe(
      '/app/Resources/bin/ffprobe',
    );
  });

  it('uses the os/arch layout in dev, matching what vendor-binaries writes', () => {
    expect(
      sidecarPath('7za', {
        packaged: false,
        platform: 'darwin',
        arch: 'arm64',
        resourcesPath: '/unused',
        appPath: '/repo',
      }),
    ).toBe('/repo/resources/bin/mac/arm64/7za');

    expect(
      sidecarPath('ffmpeg', {
        packaged: false,
        platform: 'win32',
        arch: 'x64',
        resourcesPath: '/unused',
        appPath: '/repo',
      }),
    ).toBe('/repo/resources/bin/win/x64/ffmpeg.exe');

    expect(
      sidecarPath('ffmpeg', {
        packaged: false,
        platform: 'linux',
        arch: 'x64',
        resourcesPath: '/unused',
        appPath: '/repo',
      }),
    ).toBe('/repo/resources/bin/linux/x64/ffmpeg');
  });
});
