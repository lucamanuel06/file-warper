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
 *   - 'warp:menu-open-files'  detail: string[]  (absolute paths to stage)
 *   - 'warp:menu-clear'       (no detail)        clear the staged list
 *   - 'warp:menu-reveal'      (no detail)        reveal last output, done state only
 *   - 'warp:menu-settings'    (no detail)        open settings, if/when it exists
 */

import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { pickFiles } from './ipc';

function dispatch(win: BrowserWindow, eventName: string, detail?: unknown): void {
  if (win.isDestroyed()) return;
  const script = `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: ${JSON.stringify(detail ?? null)} }));`;
  win.webContents.executeJavaScript(script).catch(() => {});
}

async function handleOpen(win: BrowserWindow): Promise<void> {
  const paths = await pickFiles(win);
  if (paths.length > 0) dispatch(win, 'warp:menu-open-files', paths);
}

export function buildMenu(getWindow: () => BrowserWindow | null): Menu {
  const withWindow = (fn: (win: BrowserWindow) => void) => {
    const win = getWindow();
    if (win) fn(win);
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => withWindow((win) => dispatch(win, 'warp:menu-settings')),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: () => withWindow((win) => void handleOpen(win)),
        },
        { type: 'separator' },
        {
          label: 'Clear List',
          accelerator: 'CmdOrCtrl+Backspace',
          click: () => withWindow((win) => dispatch(win, 'warp:menu-clear')),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
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
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reveal in Finder',
          accelerator: 'CmdOrCtrl+R',
          click: () => withWindow((win) => dispatch(win, 'warp:menu-reveal')),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    { label: 'Help', role: 'help', submenu: [] },
  ];

  return Menu.buildFromTemplate(template);
}

export function installMenu(getWindow: () => BrowserWindow | null): void {
  Menu.setApplicationMenu(buildMenu(getWindow));
}
