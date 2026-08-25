/**
 * Shared typed entry point for `linkedom`'s `parseHTML()`.
 *
 * linkedom's own `.d.ts` types `parseHTML()` as returning `Window & typeof
 * globalThis`. This project's tsconfig deliberately has no `"dom"` lib (it
 * must stay usable from both the CJS main/worker side and the bundled
 * `@warp/core`), so the bare identifier `Window` doesn't resolve to the
 * real DOM lib type — it resolves to whatever partial global `Window`
 * happens to be declared elsewhere in the same `tsc` program (in practice,
 * Electron's own `declare global { interface Window { ... } }`
 * augmentation, which has no `document`). linkedom's alternative internal
 * type exports (`Document`, `Element`, ...) are auto-generated stubs that
 * are themselves typed against `globalThis.Document` etc. — they don't
 * resolve either without the DOM lib.
 *
 * Rather than fight either of those, this module casts through a small,
 * honest structural type for exactly the DOM surface this directory
 * actually touches, in one place every call site shares.
 */

import { parseHTML } from 'linkedom';

export interface HtmlNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: readonly HtmlNode[];
}

export interface HtmlElement extends HtmlNode {
  readonly tagName: string;
  readonly children: readonly HtmlElement[];
  innerHTML: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): HtmlElement | null;
  querySelectorAll(selector: string): readonly HtmlElement[];
  remove(): void;
}

export interface HtmlDocument extends HtmlNode {
  readonly body: HtmlElement | null;
  readonly documentElement: HtmlElement;
  querySelector(selector: string): HtmlElement | null;
  querySelectorAll(selector: string): readonly HtmlElement[];
}

/** Parse an HTML string and return a structurally-typed `document`. */
export function parseHtml(html: string): HtmlDocument {
  return (parseHTML(html) as unknown as { document: HtmlDocument }).document;
}
