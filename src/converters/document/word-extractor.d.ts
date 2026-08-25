/**
 * `word-extractor` (1.0.4) ships no type declarations. This is a minimal
 * ambient module covering only the surface this directory actually uses —
 * see `node_modules/word-extractor/lib/document.js` and `lib/word.js` for
 * the full API.
 */
declare module 'word-extractor' {
  interface WordExtractorDocumentOptions {
    readonly includeFootnotes?: boolean;
  }

  class WordExtractorDocument {
    getBody(options?: WordExtractorDocumentOptions): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(options?: WordExtractorDocumentOptions): string;
    getFooters(): string;
    getAnnotations(): string;
    getTextboxes(): string;
  }

  class WordExtractor {
    extract(source: string | Buffer): Promise<WordExtractorDocument>;
  }

  export = WordExtractor;
}
