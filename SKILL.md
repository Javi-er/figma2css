---
name: figma2css
description: >-
  Update a project's design tokens CSS file from the JSON dump produced by the Raw Token Exporter
  Figma plugin. Trigger when the user asks to "update tokens from Figma", "regenerate design tokens",
  "import the Figma JSON", "sync tokens", or any variant where they want the project's CSS custom
  properties refreshed from a Figma Variables export. Also triggers on the standalone asks the
  procedure covers: responsive typography ("make the typography responsive") and layout foundations
  ("set up the breakpoints and grid from the Figma Spacing page", step 4b). Reads the JSON (clipboard
  or path), applies the project's tokens.config.json, and writes a `:root { … }` block of CSS custom
  properties into a managed region of the target CSS file. Aliases preserved, units type-aware,
  multi-mode collections expanded with name suffix.
allowed-tools: Bash, Read, Edit, Write, AskUserQuestion
---

# figma2css

## When to invoke

The user has just run the **Raw Token Exporter Figma plugin** (from Figma Community) in Figma (Dev Mode), clicked **Download JSON** (or **Copy**), and is now in their theme repo asking to update the design tokens file. Trigger on phrases like:

- "update tokens from Figma"
- "regenerate the design tokens"
- "run figma2css"
- "import the Figma JSON I just copied"
- "sync the tokens"
- "sync the tokens, and make the typography responsive" (step 2c records the choice)
- "re-export the tokens and tell me what changed" (the per-token change summary is always printed)
- "set up the breakpoints and grid from the Figma Spacing page" (jump straight to step 4b)

## What this skill does

Reads raw Figma Variables JSON, applies a per-project config, and writes a `:root { --token: value; … }` block into the project's tokens CSS file (inside managed-region markers, so anything outside them is preserved).

## Procedure

### 1. Locate the config

Look for `tokens.config.json` in this order:
1. Current working directory.
2. `./assets/`, `./src/`, `./theme/`, `./web/`.
3. Ask the user. If they don't have one, offer to scaffold a minimal one. **Before suggesting an `output` path, search the theme for an existing managed-region file** (a CSS file that contains `/* TOKENS:START */` somewhere in its body):

   ```bash
   grep -rln "TOKENS:START" themes/ css/ src/ web/ 2>/dev/null | head -5
   ```

   If exactly one match is found, use its path as the `output` value - don't ask, don't default. Some themes ship a stub tokens file pre-populated with the markers and a docblock; the export must land there to preserve the docblock and the theme's asset wiring. If multiple matches are found, match them against `tokens.config.json`'s `output` and `text_styles_output` keys first (two marker files are the EXPECTED shape when the typography split is active); ask which is canonical only when a marker file matches neither key. If none are found, fall back to `css/base/tokens.css` as the default - but warn the user that the theme didn't ship a stub file and offer to scaffold one with the markers in place.

   The minimal config is just `{"output": "<path-discovered-above>"}`. See this repo's README for the full schema.

**Sanity check before proceeding:** if the resolved `output` path does NOT exist or does NOT contain the `/* TOKENS:START */` marker, AND the theme has a stub file at `css/base/tokens.css` (or any other file with the marker), the config is wrong - surface this to the user and offer to repoint `output` to the marker file rather than creating an orphan `design-tokens.css` next to the stub.

### 2. Get the JSON input

The plugin exports the JSON two ways: its **Download JSON** button saves a file, its **Copy** button puts it on the clipboard. **Ask the user which to read from**, unless the choice is already made for you:

- If the user supplied an explicit path or filename in their request, read that and skip the ask.
- In `accept default` mode, skip the ask and use the downloaded file.
- Otherwise ask via `AskUserQuestion` (two options):
  - **Downloaded file (recommended)** - resolve the location from `source_json` in `tokens.config.json` (default `~/Downloads` when unset; `~` and `$HOME` expand). If `source_json` is a directory, read the newest `*-tokens.json` in it (`ls -t "<dir>"/*-tokens.json 2>/dev/null | head -1`); if it is a file path, read that file. Name the file you picked before reading it. If nothing matches, say so and offer the clipboard or an explicit path.
  - **Clipboard** - `pbpaste` on macOS, `xclip -selection clipboard -o` (or `wl-paste`) on Linux.

Try to `JSON.parse` the input. If it is not parseable JSON or lacks `collections` + `variables` arrays at the top level, tell the user to re-run the plugin and click **Download JSON** (or **Copy**) again - the file or clipboard probably has something else.

### 2a. Scan collection names for do-not-export markers

List the dump's collection names (`dump.collections[].name`). **If any name contains a do-not-export marker - `(do not export)`, `(don't export)`, `(no export)`, `(internal)`, case-insensitive - ask the user before exporting** via `AskUserQuestion`:

> *"The Figma file has collection(s) the designer marked as not for export: **"Utility (do not export)"** (47 variables). Skip them?*
> - *(a) **Yes - skip the marked collection(s)** (default - the designer's marker is an explicit instruction)*
> - *(b) **No - export everything** (the marker is stale / you know better)*
> - *(c) **Let me pick per collection** (when several are marked)"*

Default in `accept default` mode: **(a) skip**. On skip:

1. Add the exact collection name(s) to **`skip_collections`** in the project's `tokens.config.json` (create the key if absent) so the decision **persists across re-exports** - the next run skips silently without re-asking. If the user picks (b), record nothing; the question will re-surface next run unless they add the name to a `skip_collections: []` comment themselves.
2. The transformer enforces it: skipped collections are excluded from the emission, reported on stderr (`Skipped collections: …`), and any **dangling alias** - an *exported* variable that references a variable inside a *skipped* collection - produces a warning naming both sides (the emitted `var()` would never resolve at runtime). **Surface dangling-alias warnings to the user verbatim** - they mean the Figma file's marker is inconsistent (an exported token depends on a "do not export" one) and the user must either unskip or fix the alias in Figma.

Collections already listed in `skip_collections` don't need the prompt - they're a recorded decision. Only *newly-seen* marked collections trigger the question.

**When 2a and 2b both need answers** (marked collections AND an unrecorded typography decision), ask them in **one `AskUserQuestion` call with two questions** instead of two sequential round-trips; the answers are independent.

### 2b. Decide where + how typography lands (separate file; mixins on Sass themes)

If the dump has `textStyles` and the config doesn't yet record a decision (`text_styles_output` / `text_styles_format` absent), decide it now - once; the answer persists in `tokens.config.json`.

**Detect the theme's authoring format** (component `.scss` sources > `package.json` sass/postcss deps > source dirs; sass + postcss together = Sass).

**On a Sass theme, ask via `AskUserQuestion`:**

> *"This theme authors in Sass. The Figma file has `<N>` TextStyles. How should they be emitted?*
> - *(a) **CSS classes + Sass mixins** (default) - `@mixin headings-heading-xl { … }` plus `.headings-heading-xl { @include …; }`. Components can compose the class in Twig or `@include` the mixin in their `.scss`.*
> - *(b) **Sass mixins only** - no classes ship; components `@include` in their `.scss`. Smallest CSS payload; the scaffolder's utility-class manifest switches to mixin mode.*
> - *(c) **CSS classes only** - the plain-CSS behavior."*

**If the user picks (a) both, ask the follow-up in the same conversation** - it decides how the *component scaffolder* consumes the styles, and answering now avoids a mid-scaffold interruption later:

> *"When scaffolding components, should they compose the **class in Twig** (default - one definition site-wide, named style visible in the DOM) or **`@include` the mixin** in each component's `.scss` (pure-BEM markup; properties duplicate into each component's compiled CSS)?"*

Record the answer as **`text_styles_consumption`: `"classes"` (default) or `"mixins"`** in `tokens.config.json`. (For format (b) mixins-only or (c) classes-only the consumption is forced - don't ask, don't record.) Downstream component tooling can read this key; never mix the two mechanisms within a project.

On a **plain-CSS or PostCSS theme**: no format question (classes only); just confirm the file split.

**Propose the typography target file** (in the same prompt or a quick follow-up), defaulting by format:

| Theme / choice | Default `text_styles_output` |
|---|---|
| Plain CSS | `css/base/typography.css` |
| PostCSS (`.pcss` convention) | matching the theme's source extension, e.g. `css/base/typography.pcss` |
| Sass, classes or both | `scss/base/typography.scss` (non-partial - compiles standalone to `css/base/typography.css` under dir-mapped builds) |
| Sass, mixins only | `scss/base/_typography.scss` (partial - emits no CSS; components `@use`/`@include` it) |

Adapt the path to the theme's actual source layout (discovered structure wins over these conventional defaults). **Record both keys in `tokens.config.json`.**

**Wiring (don't skip):**
- A CSS (or compiled-from-Sass) typography file must be **attached** - wire it into the theme's asset pipeline (for a Drupal theme, `<theme>.libraries.yml` next to tokens.css) if not already there. The classes are useless unloaded.
- A mixins-only partial needs no attachment, but components must be able to `@use` it - note its path in the report so the scaffolder/devs reference it.
- **Migration note:** if classes previously lived inside the tokens file's managed region, the next `--emit tokens` splice removes them there (the move will not appear in the tokens-side `--diff` (it reports custom properties only) - call the move out in the report; `git diff` of the two spliced files shows it) and they reappear in the typography file - expected, call it out in the report.

### 2c. Responsive text styles (two-mode viewport collections)

If text styles bind properties to variables in a **two-mode collection** with viewport-anchored mode names (e.g. "Max (1440px)" / "Min (375px)") and `text_styles_responsive` isn't recorded yet, ask once via `AskUserQuestion`:

> *"`<N>` of `<M>` text styles have different sizes per viewport mode. Emit them responsively?*
> - *(a) **Stepped** (default) - small-viewport value first, one `@media (width >= <switch>)` override per property. Follow-up: the switch point isn't in the design system; I'll propose the theme's existing breakpoints map value (tablet) if one exists, else the 768px (48em) convention, recorded as pending designer confirmation.*
> - *(b) **Fluid** - `clamp()` interpolating between the two viewport anchors; needs the `(Npx)` anchors in both mode names.*
> - *(c) **Not yet** - keep the current single-value emission."*

Record `text_styles_responsive` in `tokens.config.json` (strategy + `switch` for stepped, em or px only - never rem). Works in every output format: Sass/mixins nest the media query; plain-CSS classes get one trailing `@media` block. **First re-export after enabling rewrites the affected `font-size` lines once** (`--diff` shows them as changed text styles); re-exports after that are no-ops again.

### 3. Run the transformer

```bash
node <skill-dir>/bin/transform.js \
  --input <path-to-input-json-OR-pipe-stdin> \
  --config <path-to-tokens.config.json> \
  [--diff <path-to-existing-tokens.css>] \
  [--emit all|tokens|text-styles]
```

The script writes the generated CSS to stdout. The CLI has no `--output` flag by design - writing directly to a host file would clobber the managed-region splicing this skill performs in step 4.

**When `text_styles_output` is set in the config (step 2b), run the transformer twice** and splice each emission into its own target - passing each target as its own `--diff` so re-exports report what changed in *that* file (the typography diff understands class/mixin blocks, not just custom properties):

```bash
node …/transform.js --input dump.json --config tokens.config.json --emit tokens       --diff <output>              # → splice into `output`
node …/transform.js --input dump.json --config tokens.config.json --emit text-styles  --diff <text_styles_output>  # → splice into `text_styles_output`
```

When `text_styles_output` is unset, a single default run (`--emit all`) keeps the legacy combined emission into the tokens file.

**`--diff` (recommended on every re-export):** when the `output` path in `tokens.config.json` already exists, pass it as `--diff <existing>`. The transformer reads the managed region from that file, compares it to the new emission, and writes a structured summary to stderr: `N changed, M added, K removed, U unchanged`, plus a per-token list (capped at 20 entries per category). The *actual output* is unchanged - the diff is for visibility only. Use it to:

- Confirm a no-op re-export ("no changes") before committing.
- Surface specific token changes to the user in the step-5 report.
- Catch unexpected removals (e.g., a Figma variable was deleted without an editorial decision).

The transformer's output is **deterministic** - same Figma input always produces byte-identical bytes. So a clean `git diff tokens.css` after a re-export shows exactly the tokens that changed in Figma, nothing else.

If the script exits non-zero, surface its stderr verbatim to the user - don't try to fix it without their input.

### 4. Splice into the target CSS file(s)

Same splice procedure per target - once for `output` (tokens), and again for `text_styles_output` (typography) when set. **Both files are managed identically**: the same `TOKENS:START`/`TOKENS:END` markers delimit what the export overwrites; anything outside the markers (hand-authored element defaults, `@use` lines, project additions) is preserved verbatim on every re-export. When creating the typography file fresh, give it its own `@file` header explaining the split:

```css
/**
 * @file
 * Typography - TextStyle classes/mixins exported from Figma.
 *
 * The block between TOKENS:START / TOKENS:END is managed by
 * figma2css. Anything outside the markers is preserved
 * on re-export; anything inside is overwritten.
 */
```

Read the file at the `output` path from the config.

- **If the file doesn't exist** - create it with the managed-region markers and the new block inside.
- **If the file exists and has both markers** - replace everything between `/* TOKENS:START */` and `/* TOKENS:END */` with the new block. Preserve everything above and below the markers.
- **If the file exists but has no markers** - wrap the existing content in a comment block at the bottom (so it's not lost), then prepend the new markers + block at the top. Mention this to the user so they can choose where the markers should live.

**Marker spacing (lint-clean splice):** leave exactly one blank line after the START marker and one blank line before the END marker, in every target. The emission separates its internal sections with blank lines already; the boundary blank lines keep `comment-empty-line-before` and `rule-empty-line-before` (stylelint-config-standard) clean, since the typography emission opens with a comment and both emissions end with a closing brace. Same spacing on every export, so re-splices stay byte-stable.

Default markers (configurable in `tokens.config.json` under `managed_region.start` / `.end`):
```
/* TOKENS:START */

:root {
  …
}

/* TOKENS:END */
```

### 4a. Lint the touched files (project linter detection, then autofix)

The default emission is lint-clean against `stylelint-config-standard` and `stylelint-config-standard-scss` (verified on stylelint v17): shortest-form hex, percentage alpha, blank lines between blocks and before comments, font families quoted only where recommended and always carrying a generic fallback. So with no project linter there is nothing to do; never install or configure a linter the project doesn't have.

When the project HAS a linter, run it on the files you just spliced:

1. **Detect**: `.stylelintrc*` (any extension) in the theme or repo root, a `stylelint` key in `package.json`, or a Drainpipe `Taskfile.yml` lint task.
2. **Run it scoped to the touched targets**, using the project's own command where one exists (`npm run lint:css`, `task lint`, or `npx stylelint <files>` against the project config).
3. **Autofix**: re-run with `--fix` for mechanical violations, then run once more to confirm clean. `--fix` rewrites *outside* the managed region are fine. If `--fix` or a remaining violation points *inside* the markers, do NOT hand-patch it there (the next export wipes it): a project rule is conflicting with the emission. Surface it to the user with the options that actually persist: adjust the project rule, add the generated file to `.stylelintignore` (their call, not yours), or report it as a transformer bug if the emission violates a `stylelint-config-standard` default.

**Hard rule, no exceptions: never emit, suggest, or leave behind `/* stylelint-disable */` comments (or any linter-disable directive) to make output pass.** Fix the output, the source, or surface the conflict. A disable comment in generated code silences the rule for every future export and hides real regressions.

### 4b. Foundations from the Spacing page (once per project)

When the dump carries spacing/grid variables or a two-mode viewport collection AND the theme lacks any of: a breakpoints map / media-query helper, spacing helpers, grid helpers. Code is authoritative; only missing pieces are offered. Start by asking:

> *"Does your Figma file have a Spacing (foundations) section? If so, please share the frame containing the whole page for refining: select it in Figma Dev Mode or paste its link."*

Then follow `references/foundations.md` (code-first detection, the scaffold question naming only the missing pieces, Figma analysis rules, ask-first defaults, per-format artifacts, README section, verification). Record per-piece status (`"scaffolded"` / `"declined"` / `"preexisting"`) under **`foundations`** in `tokens.config.json`; re-exports only re-ask for pieces still missing in code and unrecorded there.

### 5. Report

Show a brief summary:
- N variables emitted, M collections, K sections.
- Path written.
- Any warnings the transformer printed (name collisions, `skip_collections` mismatches, dangling aliases, missing viewport anchors).
- **Font follow-ups (if any)**: grep the new tokens for `--*font-family*`. For each unique font-family value, check whether `<theme>/css/base/fonts.css` has a matching `@font-face` block. If missing, surface the follow-up to the user: web fonts should be self-hosted rather than loaded from a third-party CDN (performance, privacy, reliability). For each missing family, download the woff2 files (Google Fonts hosts the open-licensed ones), add the `@font-face` block to the theme's fonts stylesheet, and wire it into the theme's libraries. Fonts not freely licensed surface as **"needs proprietary license + manual install"** - report them; don't auto-substitute.

- **Code review (only if warranted) - resolved BEFORE the closing summary.** A pure token or typography refresh is deterministic transformer output spliced into managed regions, so a review adds little - say it is not needed and don't ask. If this run also scaffolded layout foundations (step 4b) or hand-edited a file: when the `code-review` skill is available in this session, ask yes/no via the `AskUserQuestion` TOOL before writing the closing summary - an ask placed after the final message never fires: *"Done. Do you want to run a code review of those changes? (`/code-review low --fix`)"* - Yes, run it (recommended) / No; the built-in "Other" covers a different effort. `accept default` runs `low --fix` without asking. Run it on yes; the closing summary then notes what it changed.

Don't show the full output diff inline - the user can `git diff` themselves.

## Cross-project conventions to expect

Three real-world design systems reveal what varies across projects. The transformer handles all of these - this section documents what to expect so the skill doesn't surface false alarms.

The third shape below is the forward-looking canonical case. New projects will most likely inherit these conventions: no variable prefix, strict three-tier, component-scoped token namespaces, surface-context variants, theme-switch modes alongside responsive ones. The bullets below cover all observed conventions, biased toward this forward-looking shape as the canonical case.

- **Token prefixes are optional.** Some design systems prefix every variable with a short brand slug; others use none. The `prefix` config knob handles both (default empty when names lack one; preserve when present). Don't normalize.
- **Custom font-weight values are intentional.** Real design systems emit variable-font weights like `semibold = 550` or `regular = 425`. These are variable-font weights - **preserve verbatim**. Never round to the 100/200/…/900 set. The transformer already does this; just don't second-guess it in a follow-up edit.
- **Component-scoped token namespaces are real.** Real design systems ship `button/*`, `card/*`, `callout/*`, etc. - first-class component-level tokens alongside the generic `text/*`/`background/*` semantic tier. Emit them as-is; downstream SDCs reference them by their slugified name (`--button-fill-primary-default-on-dark`).
- **Surface-context variants (`-on-light`/`-on-dark`/`-on-<brand>`) are a token-name suffix, nothing special at the transformer level.** A mature system declares `text/highest`, `text/highest-on-light`, `text/highest-on-dark`, `text/highest-on-<brand>` as distinct variables. The transformer slugifies and emits all four; the consuming SDC picks the right one per its surface context.
- **Multi-mode collections fall into two buckets** (`responsive` vs `theme-switch`). A Radius collection with three modes (`Soft`/`Hard`/`Round`) - that's a **theme-switch**, not a viewport switch. Current transformer behaviour emits both as sibling sections with a mode-name suffix. For theme-switch modes, the developer-friendly emission is `[data-radius-theme="hard"] { --radius-md: 0; }` instead - a possible future enhancement, not yet implemented. Until then, the transformer's sibling-suffix output is technically correct; the consuming code just doesn't get a single-token-name theme switch out of the box.
- **Asterisk `*` suffix in token names** (an observed "under review" naming convention) is stripped by slugify. Information is lost - could be preserved as a code comment in `tokens.css`. Open question; not urgent.
- **Page-grid margin values vary per project.** Observed values range from 24px to 80px across projects. The transformer emits whatever variable the project declares (`grid/margin`, `Grid/margin`, etc.); consumers must read the exported variable rather than assume a value.

## Known limitations (v1)

- **Hand-edits inside the `:root` block are wiped on re-export.** The managed region is the whole `:root`, not per-line. Document obvious hand-edits in `tokens.config.json` (e.g., font-family fallback strings) and they'll survive. Otherwise the dev re-applies after re-export.
- **No reordering.** Variables emit in the Figma collection's `variableIds` order. Add `"sort": "alphabetical"` to config in a future version if needed.
- **No `@property` wrappers** - explicitly deferred. v1 matches the output shape of existing third-party plugins, minus the bugs.
- **No theme-switch mode strategy.** Multi-mode collections all emit as sibling sections with mode-name suffix. A future version may add the proposed `[data-theme="…"]` attribute-selector emission for theme-switch modes (e.g. a Radius collection's `Soft/Hard/Round`).

## Files

- `bin/transform.js` - the actual transformer (Node, no deps).
- `tests/run-tests.sh` - regression harness (fixtures + golden files; contributor tool, never runs at skill runtime). Run it after any transformer change; `UPDATE_GOLDEN=1` regenerates goldens for intentional emission changes.
- `references/foundations.md` - canonical procedure for step 4b (layout foundations scaffold: breakpoints map, spacing/grid helpers).
- See the README for a complete config schema and starting examples.
