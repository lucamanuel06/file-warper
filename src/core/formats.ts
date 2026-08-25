/**
 * FROZEN CONTRACT — the canonical format registry.
 *
 * Every `FormatId` used anywhere in the app must exist here. Converters declare
 * their `inputs`/`outputs` using these ids; the registry validates them at
 * `register()` time so a typo is a startup crash in dev, not a silently
 * unreachable graph node.
 *
 * Scope note: this list is deliberately restricted to formats we can genuinely
 * convert offline with a bundled engine. Formats that need a system install we
 * do not ship (RAW via libraw, DjVu, iWork, MOBI/AZW, 3D/CAD, PostScript) are
 * excluded on purpose — see docs/spec-engines.md §C.
 *
 * Flags: b=binary l=lossy a=animated c=container h=hub r=readOnly
 */

import type { FormatCategory, FormatDef, FormatId, MagicSig } from './types';

type Magic = readonly [offset: number, bytes: string] | readonly [number, string, string];

type Spec = readonly [
  id: string,
  label: string,
  category: FormatCategory,
  /** comma-separated; first is canonical */
  exts: string,
  mime: string,
  flags: string,
  popularity: 0 | 1 | 2 | 3,
  magic?: readonly Magic[],
  aliases?: string,
];

const M = {
  zip: [[0, '504b0304'], [0, '504b0506'], [0, '504b0708']] as const,
  ftyp: [[4, '66747970']] as const,
  ebml: [[0, '1a45dfa3']] as const,
  ogg: [[0, '4f676753']] as const,
  riff: [[0, '52494646']] as const,
  gzip: [[0, '1f8b']] as const,
  asf: [[0, '3026b2758e66cf11']] as const,
};

// prettier-ignore
const SPECS: readonly Spec[] = [
  // ── Image · raster ───────────────────────────────────────────────────────
  ['jpeg','JPEG Image','image','jpg,jpeg,jpe,jfif','image/jpeg','bl',3,[[0,'ffd8ff']],'jpg,jpe,jfif'],
  ['png','PNG Image','image','png','image/png','bh',3,[[0,'89504e470d0a1a0a']]],
  ['webp','WebP Image','image','webp','image/webp','bla',3,[[8,'57454250']]],
  ['avif','AVIF Image','image','avif','image/avif','bla',2,[[4,'6674797061766966']]],
  ['gif','GIF Image','image','gif','image/gif','bla',3,[[0,'47494638']]],
  ['tiff','TIFF Image','image','tif,tiff','image/tiff','b',2,[[0,'49492a00'],[0,'4d4d002a']],'tif'],
  ['bmp','Bitmap Image','image','bmp','image/bmp','b',1,[[0,'424d']]],
  ['ico','Windows Icon','image','ico','image/x-icon','bc',2,[[0,'00000100']]],
  ['heic','HEIC Image','image','heic','image/heic','blr',3,[[4,'6674797068656963'],[4,'667479706d696631']]],
  ['heif','HEIF Image','image','heif','image/heif','blr',1,[[4,'6674797068656978']]],
  ['psd','Photoshop Document','image','psd,psb','image/vnd.adobe.photoshop','br',1,[[0,'38425053']],'psb'],

  // ── Image · vector ───────────────────────────────────────────────────────
  ['svg','SVG Image','image','svg','image/svg+xml','',2],
  ['svgz','Compressed SVG','image','svgz','image/svg+xml','b',0,M.gzip],

  // ── Audio ────────────────────────────────────────────────────────────────
  ['mp3','MP3 Audio','audio','mp3','audio/mpeg','bl',3,[[0,'494433'],[0,'fffb'],[0,'fff3'],[0,'fff2']]],
  ['wav','WAV Audio','audio','wav','audio/wav','bh',3,[[8,'57415645']]],
  ['flac','FLAC Audio','audio','flac','audio/flac','b',2,[[0,'664c6143']]],
  ['aac','AAC Audio','audio','aac','audio/aac','bl',2,[[0,'fff1'],[0,'fff9']]],
  ['m4a','M4A Audio','audio','m4a','audio/mp4','blc',3,M.ftyp],
  ['ogg','Ogg Vorbis','audio','ogg,oga','audio/ogg','blc',2,M.ogg,'oga'],
  ['opus','Opus Audio','audio','opus','audio/opus','blc',2,M.ogg],
  ['spx','Speex Audio','audio','spx','audio/speex','blc',0,M.ogg],
  ['aiff','AIFF Audio','audio','aiff,aif','audio/aiff','b',1,[[8,'41494646']],'aif'],
  ['wma','Windows Media Audio','audio','wma','audio/x-ms-wma','blr',1,M.asf],
  ['amr','AMR Audio','audio','amr','audio/amr','bl',0,[[0,'2321414d52']]],
  ['ac3','AC-3 Audio','audio','ac3','audio/ac3','bl',0,[[0,'0b77']]],
  ['caf','Core Audio','audio','caf','audio/x-caf','bc',0,[[0,'63616666']]],
  ['au','Sun AU Audio','audio','au','audio/basic','b',0,[[0,'2e736e64']]],
  ['mka','Matroska Audio','audio','mka','audio/x-matroska','bc',0,M.ebml],

  // ── Video ────────────────────────────────────────────────────────────────
  ['mp4','MP4 Video','video','mp4','video/mp4','blc',3,M.ftyp],
  ['mov','QuickTime Video','video','mov,qt','video/quicktime','blc',3,M.ftyp,'qt'],
  ['mkv','Matroska Video','video','mkv','video/x-matroska','blc',2,M.ebml],
  ['webm','WebM Video','video','webm','video/webm','blc',2,M.ebml],
  ['avi','AVI Video','video','avi','video/x-msvideo','blc',2,[[8,'415649']]],
  ['m4v','M4V Video','video','m4v','video/x-m4v','blc',1,M.ftyp],
  ['3gp','3GP Video','video','3gp,3g2','video/3gpp','blc',0,M.ftyp,'3g2'],
  ['flv','Flash Video','video','flv','video/x-flv','blc',0,[[0,'464c5601']]],
  ['wmv','Windows Media Video','video','wmv','video/x-ms-wmv','blcr',1,M.asf],
  ['mpeg','MPEG Video','video','mpg,mpeg','video/mpeg','blc',1,[[0,'000001ba'],[0,'000001b3']],'mpg'],
  ['ts','MPEG Transport Stream','video','ts,m2ts,mts','video/mp2t','blc',1,[[0,'47']],'m2ts,mts'],
  ['ogv','Ogg Video','video','ogv','video/ogg','blc',0,M.ogg],
  ['y4m','YUV4MPEG2','video','y4m','video/x-yuv4mpeg2','b',0,[[0,'595556344d50454732']]],

  // ── Document ─────────────────────────────────────────────────────────────
  ['pdf','PDF Document','document','pdf','application/pdf','bh',3,[[0,'25504446']]],
  ['docx','Word Document','document','docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document','bc',3,M.zip],
  ['doc','Word 97-2003','document','doc','application/msword','bcr',2,[[0,'d0cf11e0a1b11ae1']]],
  ['odt','OpenDocument Text','document','odt','application/vnd.oasis.opendocument.text','bc',1,M.zip],
  ['rtf','Rich Text Format','document','rtf','application/rtf','',1,[[0,'7b5c727466']]],
  ['txt','Plain Text','document','txt,log','text/plain','h',3,undefined,'log,text'],
  ['md','Markdown','document','md,markdown','text/markdown','',3,undefined,'markdown'],
  ['html','HTML Document','document','html,htm','text/html','h',3,undefined,'htm'],
  ['xhtml','XHTML Document','document','xhtml','application/xhtml+xml','',0],
  ['epub','EPUB Ebook','document','epub','application/epub+zip','bc',2,M.zip],

  // ── Spreadsheet ──────────────────────────────────────────────────────────
  ['xlsx','Excel Workbook','spreadsheet','xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','bc',3,M.zip],
  ['xls','Excel 97-2003','spreadsheet','xls','application/vnd.ms-excel','bcr',1,[[0,'d0cf11e0a1b11ae1']]],
  ['ods','OpenDocument Spreadsheet','spreadsheet','ods','application/vnd.oasis.opendocument.spreadsheet','bc',1,M.zip],
  ['csv','CSV','spreadsheet','csv','text/csv','',3],
  ['tsv','TSV','spreadsheet','tsv','text/tab-separated-values','',1],

  // ── Presentation ─────────────────────────────────────────────────────────
  ['pptx','PowerPoint Presentation','presentation','pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation','bc',2,M.zip],
  ['ppt','PowerPoint 97-2003','presentation','ppt','application/vnd.ms-powerpoint','bcr',1,[[0,'d0cf11e0a1b11ae1']]],
  ['odp','OpenDocument Presentation','presentation','odp','application/vnd.oasis.opendocument.presentation','bc',0,M.zip],

  // ── Data ─────────────────────────────────────────────────────────────────
  ['json','JSON','data','json','application/json','h',3],
  ['jsonl','JSON Lines','data','jsonl,ndjson','application/x-ndjson','',1,undefined,'ndjson'],
  ['json5','JSON5','data','json5','application/json5','',0],
  ['yaml','YAML','data','yaml,yml','application/yaml','',3,undefined,'yml'],
  ['toml','TOML','data','toml','application/toml','',2],
  ['xml','XML','data','xml','application/xml','',2],
  ['ini','INI','data','ini','text/plain','',1],
  ['properties','Java Properties','data','properties','text/plain','',0],
  ['plist','Property List','data','plist','application/xml','',0],

  // ── Archive ──────────────────────────────────────────────────────────────
  ['zip','ZIP Archive','archive','zip','application/zip','bch',3,M.zip],
  ['tar','TAR Archive','archive','tar','application/x-tar','bc',2,[[257,'7573746172']]],
  ['tar.gz','Gzipped TAR','archive','tar.gz,tgz','application/gzip','bc',2,M.gzip,'tgz'],
  ['tar.bz2','Bzipped TAR','archive','tar.bz2,tbz2','application/x-bzip2','bc',0,[[0,'425a68']],'tbz2'],
  ['tar.xz','XZ TAR','archive','tar.xz,txz','application/x-xz','bc',0,[[0,'fd377a585a00']],'txz'],
  ['gz','Gzip','archive','gz','application/gzip','b',2,M.gzip],
  ['bz2','Bzip2','archive','bz2','application/x-bzip2','b',1,[[0,'425a68']]],
  ['xz','XZ','archive','xz','application/x-xz','b',1,[[0,'fd377a585a00']]],
  ['7z','7-Zip Archive','archive','7z','application/x-7z-compressed','bc',2,[[0,'377abcaf271c']]],
  ['rar','RAR Archive','archive','rar','application/vnd.rar','bcr',2,[[0,'526172211a0700'],[0,'526172211a070100']]],
  ['cab','Cabinet Archive','archive','cab','application/vnd.ms-cab-compressed','bcr',0,[[0,'4d534346']]],
  ['iso','ISO Disc Image','archive','iso','application/x-iso9660-image','bcr',0,[[32769,'4344303031']]],

  // ── Font ─────────────────────────────────────────────────────────────────
  ['ttf','TrueType Font','font','ttf','font/ttf','b',2,[[0,'00010000'],[0,'74727565']]],
  ['otf','OpenType Font','font','otf','font/otf','b',2,[[0,'4f54544f']]],
  ['woff','WOFF Font','font','woff','font/woff','b',2,[[0,'774f4646']]],
  ['woff2','WOFF2 Font','font','woff2','font/woff2','b',3,[[0,'774f4632']]],
  ['eot','Embedded OpenType','font','eot','application/vnd.ms-fontobject','b',0,[[34,'4c50']]],

  // ── Subtitle ─────────────────────────────────────────────────────────────
  ['srt','SubRip Subtitle','subtitle','srt','application/x-subrip','',3],
  ['vtt','WebVTT Subtitle','subtitle','vtt','text/vtt','',2],
  ['ass','ASS/SSA Subtitle','subtitle','ass,ssa','text/x-ssa','',1,undefined,'ssa'],
  ['ttml','TTML Subtitle','subtitle','ttml','application/ttml+xml','',0],
  ['sbv','SBV Subtitle','subtitle','sbv','text/plain','',0],
];

function toMagic(m: readonly Magic[] | undefined): readonly MagicSig[] | undefined {
  if (!m) return undefined;
  return m.map((x) =>
    x.length === 3
      ? { offset: x[0], bytes: x[1], mask: x[2] }
      : { offset: x[0], bytes: x[1] },
  );
}

function build(s: Spec): FormatDef {
  const [id, label, category, exts, mime, flags, popularity, magic, aliases] = s;
  return {
    id,
    label,
    category,
    extensions: exts.split(','),
    aliases: aliases ? aliases.split(',') : undefined,
    mime,
    binary: flags.includes('b'),
    lossy: flags.includes('l'),
    animated: flags.includes('a') || undefined,
    container: flags.includes('c') || undefined,
    hub: flags.includes('h') || undefined,
    readOnly: flags.includes('r') || undefined,
    magic: toMagic(magic),
    popularity,
  };
}

export const FORMATS: readonly FormatDef[] = SPECS.map(build);

export const FORMAT_BY_ID: ReadonlyMap<FormatId, FormatDef> = new Map(
  FORMATS.map((f) => [f.id, f]),
);

/** Alias/extension -> canonical id. Longest key wins on lookup (see `normalize`). */
export const FORMAT_BY_ALIAS: ReadonlyMap<string, FormatId> = (() => {
  const m = new Map<string, FormatId>();
  for (const f of FORMATS) {
    m.set(f.id, f.id);
    for (const a of f.aliases ?? []) if (!m.has(a)) m.set(a, f.id);
    for (const e of f.extensions) if (!m.has(e)) m.set(e, f.id);
  }
  return m;
})();

/** Categories in the order the UI should present them. */
export const CATEGORY_ORDER: readonly FormatCategory[] = [
  'image',
  'audio',
  'video',
  'document',
  'spreadsheet',
  'presentation',
  'data',
  'archive',
  'font',
  'subtitle',
  'other',
];

/** Per-category default target, used when a drop auto-switches the picker. */
export const DEFAULT_TARGET: Readonly<Record<FormatCategory, FormatId>> = {
  image: 'webp',
  audio: 'mp3',
  video: 'mp4',
  document: 'pdf',
  spreadsheet: 'csv',
  presentation: 'pdf',
  data: 'json',
  archive: 'zip',
  font: 'woff2',
  subtitle: 'srt',
  other: 'pdf',
};

export function getFormat(id: FormatId): FormatDef | undefined {
  return FORMAT_BY_ID.get(id);
}

/** Resolve an id, alias, or bare extension (no dot, any case) to a canonical id. */
export function normalize(idOrAliasOrExt: string): FormatId | undefined {
  return FORMAT_BY_ALIAS.get(idOrAliasOrExt.toLowerCase().replace(/^\./, ''));
}

/**
 * Match a filename's extension, longest-first so compound extensions win
 * (`archive.tar.gz` -> `tar.gz`, not `gz`).
 */
export function formatFromFilename(name: string): FormatId | undefined {
  const lower = name.toLowerCase();
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('.');
    const hit = FORMAT_BY_ALIAS.get(candidate);
    if (hit) return hit;
  }
  return undefined;
}

export function canWrite(id: FormatId): boolean {
  const f = FORMAT_BY_ID.get(id);
  return !!f && !f.readOnly;
}

export function extensionFor(id: FormatId): string {
  return FORMAT_BY_ID.get(id)?.extensions[0] ?? id;
}
