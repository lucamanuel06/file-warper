/**
 * Platform-branching window chrome, kept pure and side-effect-free so the
 * branching can be unit-tested without booting Electron.
 *
 * macOS keeps the vibrant, traffic-lighted, frameless window verified in
 * production — untouched. Windows has no traffic lights and ignores
 * `titleBarStyle: 'hiddenInset'`, so without a platform branch the window
 * would ship with no close/minimize/maximize button at all. It gets
 * `titleBarStyle: 'hidden'` + `titleBarOverlay` so Chromium draws real,
 * functional controls into the app's 52px title bar strip. Linux has no
 * `titleBarOverlay` support, so it gets a normal framed window and the
 * desktop environment draws its own title bar.
 */

import type { BrowserWindowConstructorOptions } from 'electron';

export const WINDOW_MIN_WIDTH = 460;
export const WINDOW_MIN_HEIGHT = 520;
export const TITLEBAR_HEIGHT = 52;

const SURFACE_LIGHT = '#f6f6f7';
const SURFACE_DARK = '#1e1e20';

/** Opaque surface color for platforms without vibrancy (Windows, Linux). */
export function surfaceColor(isDark: boolean): string {
  return isDark ? SURFACE_DARK : SURFACE_LIGHT;
}

/**
 * Windows Window Controls Overlay options. Fully transparent so the app's
 * own CSS-painted 52px strip shows through and the native buttons look like
 * part of it, rather than a second bar on top of it.
 */
export function titleBarOverlayOptions(isDark: boolean): {
  color: string;
  symbolColor: string;
  height: number;
} {
  return {
    color: 'rgba(0,0,0,0)',
    symbolColor: isDark ? SURFACE_LIGHT : SURFACE_DARK,
    height: TITLEBAR_HEIGHT,
  };
}

/** The platform-specific slice of `BrowserWindowConstructorOptions`. */
export function platformChromeOptions(
  platform: NodeJS.Platform,
  isDark: boolean,
): Partial<BrowserWindowConstructorOptions> {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: 'under-window',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
      roundedCorners: true,
    };
  }

  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: titleBarOverlayOptions(isDark),
      backgroundColor: surfaceColor(isDark),
    };
  }

  // Linux and any other non-darwin, non-win32 platform: no titleBarOverlay
  // support — fall back to a normal OS-drawn frame.
  return {
    frame: true,
    backgroundColor: surfaceColor(isDark),
  };
}

/**
 * macOS convention keeps the app alive (in the Dock) after the last window
 * closes. Everywhere else the process must quit, or it lingers with no
 * window and no way for the user to bring it back.
 */
export function shouldQuitOnWindowAllClosed(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin';
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

/** Full `BrowserWindow` constructor options, geometry + chrome combined. */
export function buildWindowOptions(params: {
  platform: NodeJS.Platform;
  isDark: boolean;
  bounds: WindowBounds;
  preloadPath: string;
}): BrowserWindowConstructorOptions {
  const { platform, isDark, bounds, preloadPath } = params;
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
    ...platformChromeOptions(platform, isDark),
  };
}
