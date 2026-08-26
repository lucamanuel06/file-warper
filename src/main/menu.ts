/**
 * The macOS app menu. Without `Menu.setApplicationMenu`, Cmd+C/V/X/A/Q/W
 * simply don't work — this is not cosmetic.
 *
 * `src/shared/ipc.ts` is frozen and has no main -> renderer command channel
 * for "the user pressed a menu accelerator" (only `warp:events`, which is
 * scheduler-shaped). Rather than touch the frozen contract, menu actions that
 * need the renderer's attention dispatch a `CustomEvent` into the page via
 * `executeJavaScript` — plain DOM events, not a new IPC surface. W3 should
 * add `window.addEventListener(...)` for:
 *   - 'warp:menu-open-files'    detail: string[]      (absolute paths to stage)
 *   - 'warp:menu-clear'         (no detail)             clear the staged list
 *   - 'warp:menu-reveal'        (no detail)             reveal last output, done state only
 *   - 'warp:menu-settings'      (no detail)             open settings, if/when it exists
 *   - 'warp:update-available'   detail: UpdateStatus   state is 'available' or 'error'
 *   - 'warp:update-current'     detail: UpdateStatus   state is 'current' ("you're up to date")
 */

import type { UpdateStatus } from '@shared/settings';
import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { pickFiles } from './ipc';
import { checkForUpdates } from './updates';

function dispatch(win: BrowserWindow, eventName: string, detail?: unknown): void {
  if (win.isDestroyed()) return;
  const script = `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: ${JSON.stringify(detail ?? null)} }));`;
  win.webContents.executeJavaScript(script).catch(() => {});
}

/** Routes an `UpdateStatus` to the right renderer event by its `state`. */
export function dispatchUpdateStatus(win: BrowserWindow, status: UpdateStatus): void {
  dispatch(
    win,
    status.state === 'current' ? 'warp:update-current' : 'warp:update-available',
    status,
  );
}

async function handleOpen(win: BrowserWindow): Promise<void> {
  const paths = await pickFiles(win);
  if (paths.length > 0) dispatch(win, 'warp:menu-open-files', paths);
}

async function handleCheckForUpdates(win: BrowserWindow): Promise<void> {
  const status = await checkForUpdates({ manual: true });
  dispatchUpdateStatus(win, status);
}

export interface MenuActions {
  onOpen: () => void;
  onSettings: () => void;
  onCheckForUpdates: () => void;
  onClearList: () => void;
  onReveal: () => void;
}

/**
 * Pure — no `Menu.buildFromTemplate`, no window lookups — so the per-platform
 * shape (which menu holds Quit, which accelerators exist, macOS-only roles)
 * is unit-testable without booting Electron.
 */
export function buildMenuTemplate(
  platform: NodeJS.Platform,
  appName: string,
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: actions.onOpen },
      { type: 'separator' },
      // On macOS these live in the app menu. Elsewhere there is no app menu,
      // so File is the first menu and picks them up.
      ...(isMac
        ? []
        : ([
            { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: actions.onSettings },
            { label: 'Check for Updates…', click: actions.onCheckForUpdates },
            { type: 'separator' },
          ] satisfies MenuItemConstructorOptions[])),
      { label: 'Clear List', accelerator: 'CmdOrCtrl+Backspace', click: actions.onClearList },
      { type: 'separator' },
      isMac ? { role: 'close' } : { label: 'Exit', role: 'quit' },
    ],
  };

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: actions.onSettings },
        { label: 'Check for Updates…', click: actions.onCheckForUpdates },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push(fileMenu);

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      {
        label: 'Reveal in Finder',
        accelerator: 'CmdOrCtrl+R',
        click: actions.onReveal,
      },
    ],
  });

  template.push({
    label: 'Window',
    // 'zoom' and 'front' are macOS window-cycling idioms with no equivalent
    // elsewhere.
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }],
  });

  template.push(
    isMac
      ? { label: 'Help', role: 'help', submenu: [] }
      : {
          label: 'Help',
          submenu: [{ label: `About ${appName}`, click: () => app.showAboutPanel() }],
        },
  );

  return template;
}

export function buildMenu(getWindow: () => BrowserWindow | null): Menu {
  const withWindow = (fn: (win: BrowserWindow) => void) => {
    const win = getWindow();
    if (win) fn(win);
  };

  const template = buildMenuTemplate(process.platform, app.name, {
    onOpen: () => withWindow((win) => void handleOpen(win)),
    onSettings: () => withWindow((win) => dispatch(win, 'warp:menu-settings')),
    onCheckForUpdates: () => withWindow((win) => void handleCheckForUpdates(win)),
    onClearList: () => withWindow((win) => dispatch(win, 'warp:menu-clear')),
    onReveal: () => withWindow((win) => dispatch(win, 'warp:menu-reveal')),
  });

  return Menu.buildFromTemplate(template);
}

export function installMenu(getWindow: () => BrowserWindow | null): void {
  Menu.setApplicationMenu(buildMenu(getWindow));
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
  });
}
