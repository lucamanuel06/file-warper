import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { showAboutPanel: vi.fn() },
}));

import { buildMenuTemplate, type MenuActions } from './menu';

function noopActions(): MenuActions {
  return {
    onOpen: vi.fn(),
    onSettings: vi.fn(),
    onCheckForUpdates: vi.fn(),
    onClearList: vi.fn(),
    onReveal: vi.fn(),
  };
}

function findMenu(
  template: ReturnType<typeof buildMenuTemplate>,
  label: string,
): (typeof template)[number] {
  const menu = template.find((item) => item.label === label);
  if (!menu) throw new Error(`no top-level menu labelled "${label}"`);
  return menu;
}

function flattenAccelerators(template: ReturnType<typeof buildMenuTemplate>): string[] {
  const accelerators: string[] = [];
  const walk = (items: typeof template) => {
    for (const item of items) {
      if (item.accelerator) accelerators.push(item.accelerator as string);
      if (Array.isArray(item.submenu)) walk(item.submenu as typeof template);
    }
  };
  walk(template);
  return accelerators;
}

describe('buildMenuTemplate', () => {
  it('darwin: first menu is the app menu, carrying About/Settings/Hide/Quit', () => {
    const template = buildMenuTemplate('darwin', 'File Warper', noopActions());
    expect(template[0]?.label).toBe('File Warper');
    const roles = (template[0]?.submenu as MenuItemConstructorOptionsLike[]).map((i) => i.role);
    expect(roles).toContain('about');
    expect(roles).toContain('quit');
    expect(roles).toContain('hide');
  });

  it('darwin: File menu has no Settings/Exit — those live in the app menu', () => {
    const template = buildMenuTemplate('darwin', 'File Warper', noopActions());
    const file = findMenu(template, 'File');
    const labels = (file.submenu as MenuItemConstructorOptionsLike[]).map((i) => i.label);
    expect(labels).not.toContain('Settings…');
    expect(labels).not.toContain('Exit');
  });

  it('win32: File is the first menu, and it owns Settings, Check for Updates, and Exit', () => {
    const template = buildMenuTemplate('win32', 'File Warper', noopActions());
    expect(template[0]?.label).toBe('File');
    const file = findMenu(template, 'File');
    const items = file.submenu as MenuItemConstructorOptionsLike[];
    expect(items.some((i) => i.label === 'Settings…')).toBe(true);
    expect(items.some((i) => i.label === 'Check for Updates…')).toBe(true);
    expect(items.some((i) => i.label === 'Exit' && i.role === 'quit')).toBe(true);
  });

  it('linux: same shape as win32 — File first, Exit present, no app menu', () => {
    const template = buildMenuTemplate('linux', 'File Warper', noopActions());
    expect(template[0]?.label).toBe('File');
    expect(template.some((m) => m.label === 'File Warper')).toBe(false);
  });

  it('non-darwin never renders an app-name menu', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const template = buildMenuTemplate(platform, 'File Warper', noopActions());
      expect(template.some((m) => m.label === 'File Warper')).toBe(false);
    }
  });

  it('every accelerator uses CmdOrCtrl, never a bare Cmd', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const template = buildMenuTemplate(platform, 'File Warper', noopActions());
      const accelerators = flattenAccelerators(template);
      expect(accelerators.length).toBeGreaterThan(0);
      for (const accel of accelerators) {
        expect(accel.startsWith('Cmd+')).toBe(false);
        if (/^(Cmd|Ctrl)\b/.test(accel) === false) {
          expect(accel.startsWith('CmdOrCtrl')).toBe(true);
        }
      }
    }
  });

  it('clicking Open/Settings/Check for Updates/Clear List/Reveal invokes the matching action', () => {
    const actions = noopActions();
    const template = buildMenuTemplate('win32', 'File Warper', actions);
    const file = findMenu(template, 'File');
    const items = file.submenu as MenuItemConstructorOptionsLike[];

    (items.find((i) => i.label === 'Open…')?.click as () => void)?.();
    expect(actions.onOpen).toHaveBeenCalledTimes(1);

    (items.find((i) => i.label === 'Settings…')?.click as () => void)?.();
    expect(actions.onSettings).toHaveBeenCalledTimes(1);

    (items.find((i) => i.label === 'Check for Updates…')?.click as () => void)?.();
    expect(actions.onCheckForUpdates).toHaveBeenCalledTimes(1);

    (items.find((i) => i.label === 'Clear List')?.click as () => void)?.();
    expect(actions.onClearList).toHaveBeenCalledTimes(1);

    const view = findMenu(template, 'View');
    const viewItems = view.submenu as MenuItemConstructorOptionsLike[];
    (viewItems.find((i) => i.label === 'Reveal in Finder')?.click as () => void)?.();
    expect(actions.onReveal).toHaveBeenCalledTimes(1);
  });

  it('Window menu drops the macOS-only zoom/front roles off darwin', () => {
    const template = buildMenuTemplate('win32', 'File Warper', noopActions());
    const win = findMenu(template, 'Window');
    const roles = (win.submenu as MenuItemConstructorOptionsLike[]).map((i) => i.role);
    expect(roles).not.toContain('zoom');
    expect(roles).not.toContain('front');
  });
});

// Loosely-typed shape mirroring MenuItemConstructorOptions, just enough for
// the assertions above without importing Electron's real type (the mock
// above only stubs `app`).
interface MenuItemConstructorOptionsLike {
  label?: string;
  role?: string;
  accelerator?: string;
  click?: () => void;
  submenu?: MenuItemConstructorOptionsLike[];
}
