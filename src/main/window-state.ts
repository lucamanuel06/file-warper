import fs from 'node:fs';
import path from 'node:path';
import { app, screen } from 'electron';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

const DEFAULT_STATE: WindowState = { width: 560, height: 640 };

function statePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function isWindowState(v: unknown): v is WindowState {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.width === 'number' && typeof o.height === 'number';
}

function isOnScreen(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) return true;
  const x = state.x;
  const y = state.y;
  return screen
    .getAllDisplays()
    .some(
      (d) =>
        x >= d.bounds.x &&
        y >= d.bounds.y &&
        x < d.bounds.x + d.bounds.width &&
        y < d.bounds.y + d.bounds.height,
    );
}

export function loadWindowState(): WindowState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (isWindowState(parsed) && isOnScreen(parsed)) return parsed;
  } catch {
    // No saved state yet, or it's corrupt — fall back to the default.
  }
  return { ...DEFAULT_STATE };
}

export function saveWindowState(state: WindowState): void {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state));
  } catch {
    // Best-effort — losing the remembered window position is not fatal.
  }
}
