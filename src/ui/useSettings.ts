'use client';

import type { UpdateDownloadProgress } from '@shared/ipc';
import type { AppSettings, UpdateStatus } from '@shared/settings';
import { DEFAULT_SETTINGS, RELEASES_PAGE_URL } from '@shared/settings';
import { useCallback, useEffect, useRef, useState } from 'react';

/** The releases page URL, minus its path — the repo root, for the footer link. */
export const REPO_URL = RELEASES_PAGE_URL.replace(/\/releases\/latest$/, '');

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [appVersion, setAppVersion] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [download, setDownload] = useState<UpdateDownloadProgress | null>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    void window.warp
      .invoke('settings:get')
      .then(setSettings)
      .catch(() => {
        /* main-process handler not wired up yet; keep defaults */
      });
    void window.warp
      .invoke('app:info')
      .then((info) => setAppVersion(info.version))
      .catch(() => {
        /* same */
      });
  }, []);

  // Theme: 'system' removes the override so the media-query block in
  // globals.css wins; 'light' | 'dark' stamps the attribute that beats it.
  useEffect(() => {
    if (settings.theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', settings.theme);
    }
  }, [settings.theme]);

  const patch = useCallback((p: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...p }));
    void window.warp
      .invoke('settings:set', p)
      .then(setSettings)
      .catch(() => {
        /* optimistic update already applied; nothing more to reconcile */
      });
  }, []);

  const openSheet = useCallback(() => setSheetOpen(true), []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  // Focus the gear only when the sheet transitions open -> closed, never on
  // first mount (that would steal focus at launch).
  useEffect(() => {
    if (wasOpenRef.current && !sheetOpen) gearRef.current?.focus();
    wasOpenRef.current = sheetOpen;
  }, [sheetOpen]);

  useEffect(() => {
    const onMenuSettings = () => setSheetOpen(true);
    window.addEventListener('warp:menu-settings', onMenuSettings);
    return () => window.removeEventListener('warp:menu-settings', onMenuSettings);
  }, []);

  // Main dispatches this as a plain DOM CustomEvent (like the menu events),
  // carrying the UpdateStatus object as `event.detail`.
  useEffect(() => {
    const onUpdateAvailable = (e: Event) => {
      const detail = (e as CustomEvent<UpdateStatus>).detail;
      if (detail?.state === 'available') {
        setUpdateStatus(detail);
        setUpdateDismissed(false);
      }
    };
    window.addEventListener('warp:update-available', onUpdateAvailable);
    return () => window.removeEventListener('warp:update-available', onUpdateAvailable);
  }, []);

  const checkNow = useCallback(async () => {
    setUpdateStatus({ state: 'checking' });
    try {
      const result = await window.warp.invoke('update:check', { manual: true });
      setUpdateStatus(result);
    } catch {
      setUpdateStatus({
        state: 'error',
        message: "Couldn't check for updates",
        checkedAt: 0,
      });
    }
  }, []);

  const chooseFolder = useCallback(async () => {
    const dir = await window.warp.invoke('dialog:pickFolder');
    if (dir) patch({ outputMode: 'fixed', outputDir: dir });
  }, [patch]);

  const clearFolder = useCallback(() => {
    patch({ outputMode: 'alongside', outputDir: null });
  }, [patch]);

  const openLink = useCallback((url: string) => {
    void window.warp.invoke('update:open', url);
  }, []);

  // Main owns the progress; this hook only mirrors it. Subscribing here rather
  // than inside startDownload means a download that is already running when the
  // component remounts still reports into the UI.
  useEffect(() => {
    return window.warp.on('update:progress', setDownload);
  }, []);

  /**
   * Downloads the installer in-app when the release has an asset for this
   * machine, and otherwise opens the release page — that is the honest
   * fallback when `pickAssetUrl` found nothing it could vouch for.
   */
  const startDownload = useCallback(async (status: UpdateStatus) => {
    if (status.state !== 'available') return;
    if (!status.downloadUrl) {
      void window.warp.invoke('update:open', status.url);
      return;
    }
    setDownload({ state: 'downloading', received: 0, total: 0, ratio: -1 });
    try {
      await window.warp.invoke('update:download', status.downloadUrl);
    } catch {
      // Main already pushed the terminal frame over `update:progress`; the
      // rejection here is the same failure arriving twice. Only synthesise one
      // if that event somehow never landed.
      setDownload((prev) =>
        prev?.state === 'downloading'
          ? {
              state: 'error',
              received: prev.received,
              total: prev.total,
              ratio: 0,
              message: "The download didn't finish.",
            }
          : prev,
      );
    }
  }, []);

  const cancelDownload = useCallback(() => {
    void window.warp.invoke('update:cancelDownload');
  }, []);

  const revealDownload = useCallback((filePath: string) => {
    void window.warp.invoke('update:revealDownload', filePath);
  }, []);

  const dismissUpdate = useCallback(() => {
    setUpdateDismissed(true);
    setDownload(null);
  }, []);

  return {
    settings,
    appVersion,
    sheetOpen,
    updateStatus,
    download,
    updateBarVisible: updateStatus.state === 'available' && !updateDismissed,
    gearRef,
    openSheet,
    closeSheet,
    patch,
    chooseFolder,
    clearFolder,
    checkNow,
    openLink,
    startDownload,
    cancelDownload,
    revealDownload,
    dismissUpdate,
  };
}
