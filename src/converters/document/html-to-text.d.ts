/**
 * `html-to-text` ships no types and there is no `@types/html-to-text`
 * package. Minimal ambient declaration for the one function this
 * directory uses.
 */
declare module 'html-to-text' {
  export interface HtmlToTextSelectorOptions {
    readonly [key: string]: unknown;
  }

  export interface HtmlToTextSelector {
    readonly selector: string;
    readonly format?: string;
    readonly options?: HtmlToTextSelectorOptions;
  }

  export interface HtmlToTextOptions {
    readonly wordwrap?: number | false;
    readonly selectors?: readonly HtmlToTextSelector[];
    readonly [key: string]: unknown;
  }

  export function convert(html: string, options?: HtmlToTextOptions): string;
}
