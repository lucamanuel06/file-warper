import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export async function makeFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'warp-e2e-'));
}

/** A real, decodable 1x1 PNG — magic bytes and all. */
export async function writePngFixture(dir: string, name = 'sample.png'): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, Buffer.from(PNG_1X1_BASE64, 'base64'));
  return path;
}

/** A minimal `ftyp` box — enough for magic-byte detection, not a playable video. */
export async function writeMp4Fixture(dir: string, name = 'clip.mp4'): Promise<string> {
  const path = join(dir, name);
  const box = Buffer.from([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00,
    0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x6d, 0x70, 0x34, 0x31,
  ]);
  await writeFile(path, box);
  return path;
}

/**
 * A real (tiny) ZIP. Archives are the cleanest "unreachable" fixture for the
 * mixed-drop tests: a zip can only ever become another archive format, whereas
 * video legitimately reaches image targets via a poster frame.
 */
export async function writeZipFixture(dir: string, name = 'bundle.zip'): Promise<string> {
  const { zipSync, strToU8 } = await import('fflate');
  const path = join(dir, name);
  await writeFile(path, Buffer.from(zipSync({ 'a.txt': strToU8('hello warp') })));
  return path;
}
