import path from 'node:path';
import { probeFile } from '@core/detect';
import { app, BrowserWindow, nativeTheme, systemPreferences } from 'electron';
import { MainHopRunner } from '../runtime/main-runner';
import { WorkerPool } from '../runtime/pool';
import { Scheduler } from '../runtime/scheduler';
import * as temp from '../runtime/temp';
import { registerIpcHandlers, startEventPump } from './ipc';
import { dispatchUpdateStatus, installMenu } from './menu';
import { APP_ORIGIN, registerScheme, serveExport } from './protocol';
import * as settings from './settings';
import { checkForUpdates } from './updates';
import { loadWindowState, saveWindowState } from './window-state';

/** Automatic check runs after first paint, never blocking it. */
const AUTOMATIC_UPDATE_CHECK_DELAY_MS = 4_000;

function syncNativeTheme(): void {
  nativeTheme.themeSource = settings.get().theme;
}

// MUST run at module top level, before `app.whenReady()`, exactly once.
registerScheme();

const OUT_DIR = path.join(app.getAppPath(), 'out');
const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const IS_E2E = Boolean(process.env.E2E);

let mainWindow: BrowserWindow | null = null;
const pendingOpenFiles: string[] = [];

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed()) {
    dispatchOpenFiles(mainWindow, [filePath]);
  } else {
    pendingOpenFiles.push(filePath);
  }
});

function dispatchOpenFiles(win: BrowserWindow, paths: string[]): void {
  const script = `window.dispatchEvent(new CustomEvent('warp:menu-open-files', { detail: ${JSON.stringify(paths)} }));`;
  win.webContents.executeJavaScript(script).catch(() => {});
}

function createWindow(): BrowserWindow {
  const state = loadWindowState();
  const useVibrancy = true;

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 460,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    ...(useVibrancy
      ? {
          vibrancy: 'under-window' as const,
          visualEffectState: 'followWindow' as const,
          backgroundColor: '#00000000',
        }
      : { backgroundColor: '#f6f6f7' }),
    roundedCorners: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (pendingOpenFiles.length > 0) {
      dispatchOpenFiles(win, pendingOpenFiles.splice(0));
    }
  });

  // A dropped `.html`, or any in-page navigation attempt, must never take the
  // shell window off-origin.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', () => {
    const bounds = win.getBounds();
    saveWindowState({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
  });

  if (process.platform === 'darwin') {
    try {
      const accent = systemPreferences.getAccentColor();
      win.webContents.on('did-finish-load', () => {
        win.webContents
          .insertCSS(`:root{--accent:#${accent.slice(0, 6)}}`)
          .catch(() => {});
      });
    } catch {
      // Accent colour is a cosmetic touch — never fatal if unavailable.
    }
  }

  const shouldUseDevServer = DEV_URL && !IS_E2E;
  if (shouldUseDevServer) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadURL(`${APP_ORIGIN}/`);
  }

  return win;
}

async function main(): Promise<void> {
  await app.whenReady();

  settings.load();
  syncNativeTheme();
  settings.onChange(syncNativeTheme);

  await temp.sweepStaleSessions();
  temp.registerTempCleanupHooks();

  serveExport(OUT_DIR);

  const pool = new WorkerPool();
  pool.start();
  const mainRunner = new MainHopRunner();
  mainRunner.start();
  const scheduler = new Scheduler(pool, mainRunner, async (filePath) => {
    const result = await probeFile(filePath);
    return { format: result.format, size: result.size };
  });
  await scheduler.refreshAvailability();

  mainWindow = createWindow();
  installMenu(() => mainWindow);
  registerIpcHandlers({ getWindow: () => mainWindow, scheduler });
  const stopEventPump = startEventPump(scheduler, () => mainWindow);

  const updateCheckTimer = setTimeout(() => {
    void checkForUpdates({ manual: false }).then((status) => {
      if (status.state === 'available' && mainWindow && !mainWindow.isDestroyed()) {
        dispatchUpdateStatus(mainWindow, status);
      }
    });
  }, AUTOMATIC_UPDATE_CHECK_DELAY_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });

  app.on('before-quit', () => {
    clearTimeout(updateCheckTimer);
    stopEventPump();
    scheduler.shutdownAll();
    pool.shutdown();
    mainRunner.shutdown();
  });
}

app.on('window-all-closed', () => {
  // macOS convention: the app stays alive (in the Dock) after the last
  // window closes.
  if (process.platform !== 'darwin') app.quit();
});

void main();
