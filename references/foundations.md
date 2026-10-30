# Foundations from the Spacing page (once per project)

Canonical procedure for SKILL.md step 4b. Scaffolds the theme-side layout foundations the design system implies but token export alone cannot provide: a breakpoints map + media-query helper, spacing helpers, grid helpers, and the Drupal `<theme>.breakpoints.yml`. Runs once per project; re-runs only re-ask for pieces still missing in code (see Persistence).

## Trigger + code-first detection

Run after step 4a when the dump carries spacing/grid variables or a two-mode viewport collection. A dump with neither: skip silently, ask nothing. Code wins over everything: before asking, grep the theme for each piece and mark found ones `preexisting`. Never overwrite or restate a preexisting piece; use the theme's own system (the first rule of any theme grid: use it, don't reinvent it; whose first rule is use it, don't reinvent it). A preexisting piece may carry deliberate project decisions absent from Figma (extra switch points, a desktop/max split): treat its values as the project truth and feed them into the proposals below instead of re-deriving from the two Figma anchors.

- **breakpoints**: a Sass `$breakpoints` map or `media-query` mixin, `@custom-media` rules, or a documented breakpoints header in the CSS source.
- **spacing**: mixins/utilities reading the exported `--*spacing*` custom properties.
- **grid**: a `fluid()`/`clamp()` gutter helper, a `css-grid`/`page-grid` mixin or class.
- **breakpoints_yml**: `<theme>.breakpoints.yml` next to `<theme>.libraries.yml`.

A piece already recorded in `tokens.config.json` `foundations` is silent regardless of status. Only pieces missing in code AND unrecorded trigger the question.

## The user questions

First, the frame request (the variables dump alone lacks the page's intent prose):

> *"Does your Figma file have a Spacing (foundations) section? If so, please share the frame containing the whole page for refining: select it in Figma Dev Mode or paste its link."*

If the user has no such page or skips: proceed from the dump variables alone (anchors, spacing pairs, grid values still work; the stepped-vs-fluid prose and diagrams are simply unavailable, note that in the report). Then the scaffold question, via `AskUserQuestion`, **naming only the missing pieces** (the quoted text below is the all-missing case; drop every piece marked `preexisting` from the sentence and the offer):

> *"This theme is missing layout foundations the design system's Spacing page implies: no breakpoints map or media-query helper, no spacing helpers, no grid helpers, no `<theme>.breakpoints.yml`. Scaffold them from the Figma Spacing data?*
> - *(a) **Yes, scaffold the missing pieces** (default)*
> - *(b) **Let me pick per piece** (one yes/no per missing piece, in the same `AskUserQuestion` call; each answer records individually)*
> - *(c) **No, the project handles layout itself** (recorded as declined; won't ask again)"*

Default in `accept default` mode: **(a)**.

## Figma analysis rules

- **Viewport anchors** come from the two-mode collection's `(Npx)` mode names (e.g. "Min (375px)" / "Max (1440px)"). Those two values are design-system facts.
- **Intermediate switch points are project decisions, not DS values.** Nothing between the anchors exists in Figma; see Ask-first below.
- **Spacing steps; grid gutter/margin flow.** Multi-mode spacing variables (`-mobile` suffix vs unsuffixed) switch once at the tablet point. `grid/gutter*` and `grid/margin*` interpolate fluidly between the two anchors (the DS rule: begins at the minimum at the smallest breakpoint, grows to the maximum at the largest).
- **Column counts step** (e.g. 4 to 6 to 12). Only the anchor counts may exist as variables; intermediate counts are designer decisions.

## Ask-first halts (defaults in `accept default` mode)

- **Tablet / desktop switch points**: propose the 768px (48em) / 1024px (64em) conventions, or the theme's existing values if any survive detection. Record them in a code comment as project decisions pending designer confirmation. Reuse a switch already recorded by step 2c (`text_styles_responsive.switch`), and feed the foundations value back to 2c so the project has exactly one tablet switch.
- **Intermediate column count**: propose 6 at tablet; flag as a designer decision in the same comment.
- Not a question, a hard rule: **media queries use `em` on the 16px basis, never `rem`** (the browser resolves `rem` in `@media` against its own 16px default, not the theme root; `em` avoids the trap and stays proportional under zoom). State the rule in the scaffolded file's header.

## Per-format artifacts

Authoring format and build command were detected at step 2b; content rules per `css-conventions.md` "Authoring format". Scaffolded files are hand-authored starting points owned by the project after creation: no managed-region markers, never re-spliced.

**Sass** (under the theme's discovered source dir, e.g. `scss/base/`):

- `_breakpoints.scss`: `$breakpoints` map (anchors + project switch points, provenance comments on each entry), `mq-em($px)` (`math.div($px, 16px) * 1em`), and `media-query($from: null, $until: null)`: both arguments optional, each accepting a `$breakpoints` map key or a raw px length, emitting range notation (`width >= $from`, `width <= $until - 0.0625em` so adjacent ranges don't overlap, or both). Range notation, `@if` statements (not the deprecated `if()` function), and a kebab-case name keep the scaffold clean under `stylelint-config-standard-scss`.
- `_spacing.scss`: `spacing($name, $property: padding-block)` reading `--<prefix>-spacing-#{$name}-mobile` at base and the unsuffixed property inside `media-query('tablet')`, plus a named shortcut per spacing pair found in the dump.
- `_grid.scss`: `fluid($min, $max, $vw-min, $vw-max)` returning a `clamp()` (unitless px in, rem out scaled to the config's `unit_base`), `css-grid($columns, $column-gap, $row-gap, $margin)`, and a `page-grid` mixin stepping the column count at the recorded switch points while gap/margin stay fluid.

**PostCSS**: one `@custom-media --<name> (width >= Nem)` per breakpoint in the theme's media source file; spacing and page-grid as the plain-CSS rules below, in the theme's source extension.

**Plain CSS**: a `layout.css` whose header documents the breakpoint values and the em rule (custom properties cannot be read inside `@media`), a `.page-grid` class with stepped `grid-template-columns` and fluid gap/`padding-inline` via `clamp()`; spacing stays direct consumption of the exported custom properties.

## breakpoints.yml

Scaffold `<theme>.breakpoints.yml` with one entry per breakpoint: `label`, `mediaQuery` in em on the 16px basis (mobile's mediaQuery is the empty string), ascending `weight`, `multipliers` `[1x, 2x]`. Header comment: values MUST stay hand-synced with the code-side map; a build step should eventually derive one side from the other, and until then every change touches both files. An existing file is `preexisting`: never overwrite it.

## README section

Add (or update) a "Design system foundations" section in the theme README: the breakpoint table marking which values are DS anchors and which are project decisions pending designer confirmation, how components consume the helpers (the media-query helper instead of raw values, spacing helpers instead of literal px, the page grid for the outer rail), and the breakpoints.yml hand-sync warning.

## Verification

- Sass/PostCSS themes: run the build command detected at step 2b; the scaffold must compile clean before reporting.
- Lint the scaffolded files exactly as step 4a describes (project linter detection, then autofix); same hard rule, never a linter-disable directive.
- Cross-check sync: every `mediaQuery` em value in `breakpoints.yml` equals the corresponding code-side value, and no `@media` line anywhere in the scaffold uses `rem`.

## Persistence

Record per-piece status under `foundations` in `tokens.config.json` (doc string `_foundations` in `default.tokens.config.json`):

```json
"foundations": {
  "breakpoints": "scaffolded",
  "grid": "scaffolded",
  "spacing": "declined",
  "breakpoints_yml": "preexisting"
}
```

`scaffolded` and `preexisting` mean the code exists; `declined` persists the user's no. Any recorded status silences the question on re-export; only a piece that is both missing in code and unrecorded gets asked. The user can delete a `declined` entry (or invoke the step explicitly) to be asked again.
