# Bouwplan — dark-mode fix voor native `<select>`-popups (Windows)

## Het probleem

In dark mode is de tekst in de uitklappende native dropdown van beide `<select>`s
zwart-op-donker (onleesbaar) op Windows, terwijl de rest van de UI correct donker is.

Twee oorzaken die samenvallen:

1. **`color-scheme` volgt het thema niet.** `src/ui/globals.css:40` zet statisch
   `color-scheme: light dark;` op `:root`. Het thema zelf wordt daarnaast wél
   geschakeld — licht als `:root`-default, donker via
   `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`
   (regel ~111) en via `:root[data-theme="dark"]` (regel ~133), gestempeld door
   `src/ui/useSettings.ts:36-42`. Omdat `color-scheme` nooit meebeweegt, laat Chromium
   de *systeem*voorkeur beslissen over natief gerenderde controls. Forceert de gebruiker
   in-app dark terwijl Windows op licht staat (of andersom), dan rendert de popup in de
   verkeerde stand.
2. **`option`/`optgroup` erven `color` niet betrouwbaar** in de native popup op Windows.
   De gesloten box krijgt `color: var(--text-primary)` (`FormatSelect.module.css:15`,
   `Controls.module.css:42`), maar de popup valt terug op de UA-default (zwart).

Beide selects zijn geraakt:
`src/ui/components/FormatSelect/FormatSelect.tsx` (+ `.module.css`) en
`src/ui/components/Controls/Controls.tsx` → `SelectField` (+ `.module.css`), die laatste
gebruikt door `src/ui/components/SettingsSheet/SettingsSheet.tsx` (o.a. de collision-select).
Andere `<select>`/`<option>`-elementen bestaan niet in de codebase — geverifieerd.

## Wat er gebouwd wordt

Een gerichte bugfix, geen refactor. Drie losse brokken:

### 1. CSS-fix (`src/ui/globals.css` + beide `.module.css`)

- `color-scheme` wordt thema-afhankelijk:
  - `:root` → `color-scheme: light;` (vervangt `light dark`)
  - nieuw `:root[data-theme="light"]` blok → `color-scheme: light;`
    (expliciet, want dit blok bestáát nog niet — de lichte tokens leven in `:root`)
  - `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` → `color-scheme: dark;`
  - `:root[data-theme="dark"]` → `color-scheme: dark;`
  Daarmee matchen native controls (select-popup, scrollbars, checkboxes, caret) altijd
  met het *toegepaste* thema, ook los van de OS-voorkeur.
- In `FormatSelect.module.css` en `Controls.module.css` krijgen `option` en `optgroup`
  **expliciet** `color: var(--text-primary)` en `background-color: var(--bg-elevated)`,
  gescoped onder `.select` (CSS Modules: `.select option { … }`). `--bg-elevated` is in
  beide thema's ondoorzichtig (`#ffffff` / `#2a2a2d`), anders dan het translucente
  `--bg-subtle` van de gesloten box — een popup mag niet doorschijnen.
- Verder niets: geen andere selectors, tokens of gedrag aangeraakt.

### 2. Regressietests (`test/unit/`, `e2e/settings.spec.ts`)

- Unit (vitest, **node**-env — er is geen jsdom/RTL in dit project): lees de drie
  CSS-bestanden als tekst en assert de invarianten: geen `color-scheme: light dark`
  meer, `color-scheme` aanwezig in elk van de vier thema-blokken, en `option`/`optgroup`
  met `color` + `background-color` in beide modules.
- E2E (Playwright + Electron): breid de bestaande test
  `'the theme segmented control flips data-theme on <html>'` uit met een assert op
  `getComputedStyle(document.documentElement).colorScheme` → `dark` / `light` na het
  omschakelen. Dat is de echte gedragscheck in Chromium.

### 3. Documentatie (`docs/spec-ui.md`)

De spec toont zelf nog `color-scheme: light dark;` (regel ~209) en beschrijft de picker
in §"The target format picker — a native `<select>`". Beide worden bijgewerkt met de
nieuwe invariant, zodat de volgende agent hem niet terugdraait.

## Technieken

Plain CSS + CSS Modules met bestaande custom properties (geen Tailwind — bewuste keuze
van dit project, zie `docs/spec-ui.md` §3). Vitest voor de statische CSS-assertions,
Playwright/Electron voor de runtime-assert. Geen nieuwe dependencies; `package.json`,
`src/core/types.ts`, `src/core/formats.ts` en `src/shared/ipc.ts` zijn frozen en worden
niet aangeraakt.

## Hoe het draait

`node_modules` ontbreekt in deze werkmap, dus eerst installeren. Daarna serveert
`next dev` de renderer op `http://localhost:3000`; `src/ui/mockBridge.ts` installeert een
dev-fake `window.warp`, zodat de UI zonder Electron-main werkt en de selects in de
browser te bekijken zijn.

```bash
cd /workspace && (test -d node_modules || npm install --no-audit --no-fund) && npx next dev -p 3000
```

Controles:

```bash
npx biome check src/ui test e2e
npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
npx vitest run
npx playwright test        # vereist een display
```

## Verificatiegrenzen — expliciet

- Er is **geen** `DISPLAY` en geen Xvfb in deze omgeving, en Electron is niet headless te
  draaien. De Playwright/Electron-suite is hier dus vermoedelijk niet uit te voeren; de
  toegevoegde e2e-assert wordt geleverd als code die op een machine mét display groen moet
  draaien, niet als hier bewezen resultaat.
- **Windows-verificatie is in deze omgeving onmogelijk** (Linux-container). De native
  dropdown-popup rendert per platform anders; visuele bevestiging op Windows moet een mens
  doen. Wat hier wél aantoonbaar is: de CSS-invarianten (unit), `colorScheme` op
  `documentElement` in Chromium (e2e, met display), en de licht/donker-weergave van beide
  selects in `next dev`.
- Wie oplevert, meldt per check of hij is gedraaid en wat de uitvoer was. Niets groen
  noemen dat niet gedraaid is.

## Oplevering

Conventional commits per gebied (`fix(ui): …`, `test(ui): …`, `docs(ui): …`), op een
branch van `main`, niet pushen. De promotie naar `main` op GitHub gebeurt via de
voorstel-knop en vereist menselijke bevestiging — het werk wordt zo opgeleverd dat het
klaar staat zodra lint, typecheck en tests groen zijn.
