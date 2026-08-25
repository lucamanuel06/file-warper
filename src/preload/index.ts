/**
 * CJS, sandbox-safe: `sandbox: true` means no Node builtins here — only
 * `require('electron')`. Implements exactly the `WarpApi` frozen in
 * `src/shared/ipc.ts`.
 */

import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from 'electron';
import type { IpcEventMap, IpcInvokeMap, WarpApi } from '../shared/ipc';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/ipc';

// `tsconfig.node.json` has no DOM lib (it also type-checks Node-only worker
// code) — preload is the one file in that program that legitimately runs in
// a renderer-like context, hence this minimal ambient declaration.
declare const window: { dispatchEvent: (event: Event) => boolean };

const invokeChannels: readonly string[] = INVOKE_CHANNELS;
const eventChannels: readonly string[] = EVENT_CHANNELS;

const api: WarpApi = {
  invoke: (channel, ...args) => {
    if (!invokeChannels.includes(channel)) {
      throw new Error(`blocked channel: ${String(channel)}`);
    }
    return ipcRenderer.invoke(channel, ...args) as ReturnType<
      IpcInvokeMap[typeof channel]
    >;
  },

  // Returning the disposer matters: `contextBridge` cannot pass a function
  // reference back across the bridge for a later `off()`, so a renderer that
  // unsubscribes with the raw callback would leak a listener on every
  // re-render.
  on: (event, cb) => {
    if (!eventChannels.includes(event)) {
      throw new Error(`blocked event: ${String(event)}`);
    }
    const handler = (_e: IpcRendererEvent, payload: IpcEventMap[typeof event]) =>
      cb(payload);
    ipcRenderer.on(event, handler);
    return () => {
      ipcRenderer.off(event, handler);
    };
  },

  // The ONLY correct way to resolve a dropped file to an absolute path
  // (`File.path` was removed in Electron 32). Must be called synchronously in
  // the drop handler — `DataTransfer` is neutered after any `await`.
  pathsForFiles: (files) => files.map((f) => webUtils.getPathForFile(f)),
};

contextBridge.exposeInMainWorld('warp', api);

if (process.env.E2E) {
  contextBridge.exposeInMainWorld('__test', {
    /** Injects file paths as if they'd been dropped/opened, bypassing real OS drag events. */
    stagePaths: (paths: string[]) => {
      window.dispatchEvent(new CustomEvent('warp:menu-open-files', { detail: paths }));
    },
  });
}
