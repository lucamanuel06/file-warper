/**
 * `turndown-plugin-gfm` ships no type declarations and there is no
 * `@types/turndown-plugin-gfm` package. This ambient module keeps
 * `html-to-md.ts` free of `any` without touching `node_modules`.
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}
