/**
 * `html -> epub` via `@lesjoursfr/html-to-epub`.
 *
 * That library downloads `http(s)://` image sources with `axios` when it
 * renders — completely wrong for an offline-only app. `data:` URIs are safe:
 * reading its source shows it can't resolve a MIME type from a data URI, so
 * it leaves that `src` untouched rather than attempting a "download". But we
 * don't rely on that as the only guard — we strip every `http(s)://` image
 * out of the HTML ourselves *before* handing it to the library, so no
 * network attempt is possible regardless of its internals.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type {
  ConversionInput,
  ConversionOutput,
  ConvertContext,
  Converter,
  ConverterOptions,
  ConvertResult,
  EdgeCost,
} from '@core/types';
import { ConversionError } from '@core/types';
import { EPub } from '@lesjoursfr/html-to-epub';
import { parseHTML } from 'linkedom';

interface StrippedImages {
  readonly html: string;
  readonly removedCount: number;
}

/** Remove every `<img src="http(s)://...">` — never let this hit the network. */
function stripRemoteImages(html: string): StrippedImages {
  const { document } = parseHTML(
    /<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`,
  );
  const images = Array.from(document.querySelectorAll('img')) as unknown as {
    getAttribute(name: string): string | null;
    remove(): void;
  }[];

  let removedCount = 0;
  for (const img of images) {
    const src = img.getAttribute('src') ?? '';
    if (/^https?:\/\//i.test(src)) {
      img.remove();
      removedCount += 1;
    }
  }

  const body = document.body as unknown as { innerHTML: string } | null;
  return { html: body?.innerHTML ?? '', removedCount };
}

function deriveTitle(html: string, fallback: string): string {
  const { document } = parseHTML(
    /<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`,
  );
  const titleText = (document.querySelector('title')?.textContent ?? '').trim();
  if (titleText.length > 0) return titleText;
  const h1Text = (document.querySelector('h1')?.textContent ?? '').trim();
  if (h1Text.length > 0) return h1Text;
  return fallback;
}

export const htmlToEpubConverter: Converter = {
  id: 'doc:html-to-epub',
  name: 'HTML to EPUB',
  engine: 'pure-js',
  residency: 'worker',

  inputs: ['html'],
  outputs: ['epub'],

  cost(): EdgeCost {
    // Headings, paragraphs, lists, tables, and embedded images survive;
    // pagination/exact layout does not (reflowable ebook format by design).
    return { retention: 0.75, effort: 3, structure: 0.7 };
  },

  async availability() {
    return { available: true };
  },

  async convert(
    input: ConversionInput,
    output: ConversionOutput,
    _options: ConverterOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    if (ctx.signal.aborted) {
      throw new ConversionError({
        code: 'E_CANCELLED',
        userMessage: 'The conversion was cancelled.',
        retryable: false,
      });
    }

    ctx.onProgress({ ratio: 0, message: 'Reading HTML' });

    let html: string;
    try {
      html = (await input.readBuffer()).toString('utf8');
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: `Could not read the HTML file "${input.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.2, message: 'Removing remote images' });

    const fallbackTitle = basename(input.path, extname(input.path)) || 'Document';
    const title = deriveTitle(html, fallbackTitle);
    const { html: safeHtml, removedCount } = stripRemoteImages(html);

    ctx.onProgress({ ratio: 0.4, message: 'Building EPUB' });

    const epub = new EPub(
      {
        title,
        description: '',
        content: [{ title, data: safeHtml }],
        tempDir: ctx.scratchDir,
      },
      output.path,
    );

    try {
      await epub.render();
    } catch (cause) {
      throw new ConversionError({
        code: 'E_ENGINE',
        userMessage: 'The EPUB could not be built.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.95, message: 'Done' });

    let bytes: number | undefined;
    try {
      bytes = (await readFile(output.path)).byteLength;
    } catch {
      bytes = undefined;
    }

    const warnings: string[] = [];
    if (removedCount > 0) {
      warnings.push(
        `Removed ${removedCount} remote image(s) — this app converts offline only and does not fetch images.`,
      );
    }

    ctx.onProgress({ ratio: 1, message: 'Done' });

    return {
      bytes,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};
