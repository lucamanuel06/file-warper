import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression tests for the dark-mode native <select> popup bug: unreadable
 * text came from `color-scheme` never following the in-app theme, plus
 * `option`/`optgroup` not getting an explicit color in the popup. These
 * tests read the CSS as plain text (this project's vitest runs in node,
 * no jsdom/RTL) and assert the invariants the fix relies on, so a future
 * edit can't silently reintroduce the static `light dark` value or drop
 * the option/optgroup colors.
 */

const repoRoot = process.cwd();
const globalsCssPath = join(repoRoot, 'src/ui/globals.css');
const formatSelectCssPath = join(
  repoRoot,
  'src/ui/components/FormatSelect/FormatSelect.module.css',
);
const controlsCssPath = join(repoRoot, 'src/ui/components/Controls/Controls.module.css');

const globalsCss = readFileSync(globalsCssPath, 'utf8');
const formatSelectCss = readFileSync(formatSelectCssPath, 'utf8');
const controlsCss = readFileSync(controlsCssPath, 'utf8');

interface CssRule {
  selector: string;
  body: string;
}

/**
 * Minimal brace-scanner: splits CSS text into top-level { selector, body }
 * rules without understanding selector or declaration syntax. Call again
 * on a rule's `body` to descend into nested rules (e.g. the rules inside
 * an `@media` block). This keeps the assertions below robust to
 * reformatting/reordering of the CSS, unlike a single big regex.
 */
function parseTopLevelRules(css: string): CssRule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  let selectorBuf = '';
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (depth > 0 && j < stripped.length) {
        if (stripped[j] === '{') depth++;
        else if (stripped[j] === '}') depth--;
        if (depth > 0) j++;
      }
      rules.push({ selector: selectorBuf.trim(), body: stripped.slice(i + 1, j) });
      selectorBuf = '';
      i = j + 1;
      continue;
    }
    if (ch === '}') {
      selectorBuf = '';
      i++;
      continue;
    }
    selectorBuf += ch;
    i++;
  }
  return rules;
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, '');
}

function findRule(rules: CssRule[], normalizedSelector: string): CssRule | undefined {
  return rules.find((r) => normalizeSelector(r.selector) === normalizedSelector);
}

function listSelectors(rules: CssRule[]): string {
  return rules.map((r) => `  - ${JSON.stringify(r.selector)}`).join('\n');
}

describe('color-scheme follows the applied theme, not just the OS preference (globals.css)', () => {
  const rules = parseTopLevelRules(globalsCss);

  it('never falls back to the static `color-scheme: light dark`', () => {
    expect(
      globalsCss,
      'Found `color-scheme: light dark` in globals.css. That value hands the decision over to ' +
        'the OS preference for natively-rendered controls (select popups, scrollbars, checkboxes) ' +
        'regardless of the theme applied in-app — exactly the bug this fix removes.',
    ).not.toMatch(/color-scheme\s*:\s*light\s+dark\s*;/);
  });

  it('sets `color-scheme: light` on the `:root` default', () => {
    const root = findRule(rules, ':root');
    expect(
      root,
      `Expected a top-level \`:root { ... }\` rule in globals.css. Found selectors:\n${listSelectors(rules)}`,
    ).toBeDefined();
    expect(
      root?.body,
      '`:root` must declare `color-scheme: light;` so native controls default to the light ' +
        'rendering that matches the light token set also defined in this block.',
    ).toMatch(/color-scheme\s*:\s*light\s*;/);
  });

  it('sets `color-scheme: light` on the explicit `:root[data-theme="light"]` override', () => {
    const lightOverride = findRule(rules, ':root[data-theme="light"]');
    expect(
      lightOverride,
      '`:root[data-theme="light"] { ... }` must exist in globals.css — it is what lets a user ' +
        `force light mode while the OS is in dark mode. Found selectors:\n${listSelectors(rules)}`,
    ).toBeDefined();
    expect(
      lightOverride?.body,
      '`:root[data-theme="light"]` must set `color-scheme: light;` explicitly, otherwise forcing ' +
        'light mode in-app while the OS prefers dark leaves native controls rendered dark.',
    ).toMatch(/color-scheme\s*:\s*light\s*;/);
  });

  it('sets `color-scheme: dark` inside the prefers-color-scheme media query, on :root:not([data-theme="light"])', () => {
    const mediaRule = findRule(rules, '@media(prefers-color-scheme:dark)');
    expect(
      mediaRule,
      `Expected an \`@media (prefers-color-scheme: dark) { ... }\` rule in globals.css. Found selectors:\n${listSelectors(rules)}`,
    ).toBeDefined();

    const nested = mediaRule ? parseTopLevelRules(mediaRule.body) : [];
    const notLight = findRule(nested, ':root:not([data-theme="light"])');
    expect(
      notLight,
      '`:root:not([data-theme="light"])` must exist inside the dark media query — it applies the ' +
        'OS dark preference unless the user has explicitly forced light mode in-app. Found nested ' +
        `selectors:\n${listSelectors(nested)}`,
    ).toBeDefined();
    expect(
      notLight?.body,
      'The OS-preference dark block must set `color-scheme: dark;`, otherwise native controls stay ' +
        'in whatever `color-scheme` `:root` declared even when the system (and the app) are dark.',
    ).toMatch(/color-scheme\s*:\s*dark\s*;/);
  });

  it('sets `color-scheme: dark` on the explicit `:root[data-theme="dark"]` override', () => {
    const darkOverride = findRule(rules, ':root[data-theme="dark"]');
    expect(
      darkOverride,
      '`:root[data-theme="dark"] { ... }` must exist in globals.css — it is what lets a user force ' +
        `dark mode while the OS is in light mode. Found selectors:\n${listSelectors(rules)}`,
    ).toBeDefined();
    expect(
      darkOverride?.body,
      '`:root[data-theme="dark"]` must set `color-scheme: dark;` explicitly, otherwise forcing dark ' +
        'mode in-app while the OS prefers light renders the native select popup with dark text on a ' +
        'light background — the original bug.',
    ).toMatch(/color-scheme\s*:\s*dark\s*;/);
  });
});

function targetsTag(selector: string, tag: 'option' | 'optgroup'): boolean {
  const tagAtEnd = new RegExp(`(^|\\s)${tag}$`);
  return selector
    .split(',')
    .map((part) => part.trim())
    .some((part) => tagAtEnd.test(part));
}

const HAS_COLOR = /(?<![\w-])color\s*:/;
const HAS_BACKGROUND_COLOR = /background-color\s*:/;

function assertPopupColorsFor(
  css: string,
  filePath: string,
  tag: 'option' | 'optgroup',
): void {
  const rules = parseTopLevelRules(css);
  const rule = rules.find((r) => targetsTag(r.selector, tag));
  expect(
    rule,
    `Expected a CSS rule in ${filePath} targeting \`${tag}\` (e.g. \`.select ${tag}\`). Without it, ` +
      `the native select popup falls back to the UA default color on Windows and renders unreadable ` +
      `text against the dark popup background. Found selectors:\n${listSelectors(rules)}`,
  ).toBeDefined();

  expect(
    rule?.body,
    `${filePath}: the \`${tag}\` rule must set \`color: var(--text-primary)\` (or equivalent) — the ` +
      `closed <select> box inherits this, but the popup does not, on Windows.`,
  ).toMatch(HAS_COLOR);

  expect(
    rule?.body,
    `${filePath}: the \`${tag}\` rule must set an opaque \`background-color\` (e.g. \`var(--bg-elevated)\`) ` +
      `— an opaque background is required so the popup doesn't show the translucent page background ` +
      `bleeding through behind the (now correctly colored) text.`,
  ).toMatch(HAS_BACKGROUND_COLOR);
}

describe('native <select> popup: option/optgroup get an explicit, opaque color (FormatSelect.module.css)', () => {
  it('styles `option`', () => {
    assertPopupColorsFor(formatSelectCss, 'FormatSelect.module.css', 'option');
  });

  it('styles `optgroup`', () => {
    assertPopupColorsFor(formatSelectCss, 'FormatSelect.module.css', 'optgroup');
  });
});

describe('native <select> popup: option gets an explicit, opaque color (Controls.module.css)', () => {
  it('styles `option`', () => {
    assertPopupColorsFor(controlsCss, 'Controls.module.css', 'option');
  });
});
