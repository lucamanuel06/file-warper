/**
 * @warp/core — tiny filesystem helpers shared by detect.ts.
 *
 * Kept separate so it's obvious exactly how much of `node:fs` core reaches
 * for: reading a bounded number of bytes, never a whole multi-GB file.
 */

import { open, readFile, stat } from 'node:fs/promises';

export async function statSize(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return s.size;
}

/** Reads at most `n` bytes from the start of the file. */
export async function readHead(filePath: string, n: number): Promise<Buffer> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Reads the whole file, capped at `maxBytes` (reads the leading portion only). */
export async function readFileCapped(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const size = await statSize(filePath);
  if (size <= maxBytes) return readFile(filePath);
  return readHead(filePath, maxBytes);
}
