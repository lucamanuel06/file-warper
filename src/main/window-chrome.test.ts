import { describe, expect, it } from 'vitest';
import {
  buildWindowOptions,
  platformChromeOptions,
  shouldQuitOnWindowAllClosed,
  surfaceColor,
  titleBarOverlayOptions,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
} from './window-chrome';

describe('platformChromeOptions', () => {
  it('darwin: keeps the vibrant, traffic-lighted, transparent window', () => {
    const opts = platformChromeOptions('darwin', false);
    expect(opts).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: 'under-window',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
      roundedCorners: true,
    });
  });

  it('darwin: is identical regardless of the dark-mode flag (vibrancy follows the system)', () => {
    expect(platformChromeOptions('darwin', true)).toEqual(
      platformChromeOptions('darwin', false),
    );
  });

  it('win32: hides the native title bar and requests a real overlay', () => {
    const opts = platformChromeOptions('win32', false);
    expect(opts.titleBarStyle).toBe('hidden');
    expect(opts.titleBarOverlay).toEqual({
      color: 'rgba(0,0,0,0)',
      symbolColor: '#1e1e20',
      height: 52,
    });
    expect(opts.backgroundColor).toBe('#f6f6f7');
    expect(opts.frame).toBeUndefined();
    expect(opts.vibrancy).toBeUndefined();
  });

  it('win32: flips overlay symbol color and background for dark mode', () => {
    const opts = platformChromeOptions('win32', true);
    expect(opts.titleBarOverlay).toEqual({
      color: 'rgba(0,0,0,0)',
      symbolColor: '#f6f6f7',
      height: 52,
    });
    expect(opts.backgroundColor).toBe('#1e1e20');
  });

  it('linux: falls back to a normal OS-framed window', () => {
    const opts = platformChromeOptions('linux', false);
    expect(opts).toEqual({ frame: true, backgroundColor: '#f6f6f7' });
    expect(opts.titleBarOverlay).toBeUndefined();
    expect(opts.titleBarStyle).toBeUndefined();
  });

  it('linux: uses the dark surface color in dark mode', () => {
    expect(platformChromeOptions('linux', true).backgroundColor).toBe('#1e1e20');
  });

  it('an unknown non-darwin, non-win32 platform also falls back to a framed window', () => {
    expect(platformChromeOptions('freebsd', false)).toEqual({
      frame: true,
      backgroundColor: '#f6f6f7',
    });
  });
});

describe('surfaceColor / titleBarOverlayOptions', () => {
  it('surfaceColor is the opaque light/dark token pair', () => {
    expect(surfaceColor(false)).toBe('#f6f6f7');
    expect(surfaceColor(true)).toBe('#1e1e20');
  });

  it('titleBarOverlayOptions is transparent with height 52 in both themes', () => {
    expect(titleBarOverlayOptions(false).color).toBe('rgba(0,0,0,0)');
    expect(titleBarOverlayOptions(true).color).toBe('rgba(0,0,0,0)');
    expect(titleBarOverlayOptions(false).height).toBe(52);
    expect(titleBarOverlayOptions(true).height).toBe(52);
  });
});

describe('buildWindowOptions', () => {
  it('keeps the 560x640 / min 460x520 geometry on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const opts = buildWindowOptions({
        platform,
        isDark: false,
        bounds: { width: 560, height: 640 },
        preloadPath: '/preload.js',
      });
      expect(opts.width).toBe(560);
      expect(opts.height).toBe(640);
      expect(opts.minWidth).toBe(WINDOW_MIN_WIDTH);
      expect(opts.minHeight).toBe(WINDOW_MIN_HEIGHT);
    }
  });

  it('carries the sandboxed webPreferences through on every platform', () => {
    const opts = buildWindowOptions({
      platform: 'win32',
      isDark: false,
      bounds: { width: 560, height: 640 },
      preloadPath: '/preload.js',
    });
    expect(opts.webPreferences).toEqual({
      preload: '/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    });
  });

  it('carries x/y through when the persisted bounds include a position', () => {
    const opts = buildWindowOptions({
      platform: 'linux',
      isDark: false,
      bounds: { x: 100, y: 200, width: 560, height: 640 },
      preloadPath: '/preload.js',
    });
    expect(opts.x).toBe(100);
    expect(opts.y).toBe(200);
  });
});

describe('shouldQuitOnWindowAllClosed', () => {
  it('does not quit on macOS', () => {
    expect(shouldQuitOnWindowAllClosed('darwin')).toBe(false);
  });

  it('quits on Windows and Linux, so the process never lingers with no window', () => {
    expect(shouldQuitOnWindowAllClosed('win32')).toBe(true);
    expect(shouldQuitOnWindowAllClosed('linux')).toBe(true);
  });
});
