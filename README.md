# figma2css

Design tokens from Figma to CSS, with no enterprise plan and no middleware: a [Figma plugin](https://www.figma.com/community/plugin/1697764012142993786/raw-token-exporter) that dumps your Variables and TextStyles as JSON, and a [Claude Code](https://claude.com/claude-code) skill (with a zero-dependency CLI underneath) that turns the dump into CSS custom properties, typography utilities, and layout foundations inside your own stylesheet.

A standard Figma Dev Mode seat is enough. Nothing leaves your machine.

## What it does

- **Variables to CSS custom properties**, written inside a managed region of a stylesheet you already own (`/* TOKENS:START */ ... /* TOKENS:END */`); everything outside the markers is preserved on every re-export.
- **Aliases preserved** as `var()` references instead of flattened values, so your semantic tiers survive the trip.
- **Type-aware units** per Figma variable scope: font sizes in `rem`, radii in `px`, weights unitless, line heights unit-free - all overridable.
- **Multi-mode collections** expanded with name suffixes (light/dark, breakpoints, themes).
- **TextStyles** emitted as utility classes, SCSS mixins, or both, with optional **responsive typography** (stepped breakpoints or fluid `clamp()`).
- **Layout foundations** scaffold: a breakpoints map and media/container query helpers derived from your Figma spacing variables.
- **"Do not export" respected**: collections the designer marks stay out, with warnings when an exported token dangles against a skipped one.
- **Deterministic output**: same input, same bytes. A `--diff` mode shows what a re-export would change.

## Install

**1. The Figma plugin** - install [Raw Token Exporter from Figma Community](https://www.figma.com/community/plugin/1697764012142993786/raw-token-exporter). It runs in Dev Mode; a Dev seat on the file is enough, no edit access needed.

**2. The Claude Code skill** - clone this repo and symlink it into your skills directory:

```bash
git clone https://github.com/Javi-er/figma2css.git ~/projects/figma2css
mkdir -p ~/.claude/skills
ln -s ~/projects/figma2css ~/.claude/skills/figma2css
```

New Claude Code sessions pick the skill up automatically.

**No Claude Code?** The transformer works standalone:

```bash
node bin/transform.js path/to/your-tokens.json
```

## Usage

1. In Figma: open your file in Dev Mode, run **Raw Token Exporter**, click **Extract**, then **Download JSON**.
2. In your theme repo, in a Claude Code session: say "update tokens from Figma" (or "sync the tokens", "import the Figma JSON").
3. The skill finds your `tokens.config.json`, reads the downloaded dump, and splices the generated CSS into the managed region, reporting every token that changed.

Also covered on request: "make the typography responsive" and "set up the breakpoints and grid from the Figma spacing page".

## Configuration (`tokens.config.json`)

Copy `default.tokens.config.json` to `tokens.config.json` next to your CSS source and adjust. Keys the transformer reads:

| Key | Values | Default | Purpose |
|---|---|---|---|
| `output` | path | - | The stylesheet carrying the managed region |
| `indent` | string | two spaces | Indentation unit |
| `unit_base` | number | `16` | px-per-rem divisor |
| `default_unit` | `unitless` `px` `rem` `em` `auto-line-height` `auto-letter-spacing` | `rem` | Unit for floats whose scope matches nothing in `scope_units` |
| `px_hints` | boolean | `true` | Append `/* Npx */` comments after rem values |
| `managed_region.start` / `.end` | strings | `/* TOKENS:START */` / `/* TOKENS:END */` | Region markers |
| `scope_units` | object | sensible per-scope map | Per-Figma-scope unit overrides |
| `skip_collections` | array | - | Collections excluded from emission |
| `text_style_prefix` | string | `""` | Prefix on emitted class/mixin names |
| `text_styles_format` | `css-classes` `scss-mixins` `both` | `css-classes` | TextStyle emission shape |
| `text_styles_output` | path | - | Separate typography file (`.scss` targets nest media queries) |
| `text_styles_responsive` | `{strategy: stepped\|fluid, switch: <n>em\|<n>px}` | - | Responsive typography |

Skill-level keys (read by the procedure, not the CLI): `source_json` (where the plugin's download lands, default `~/Downloads`), `foundations`, `text_styles_consumption` (recorded for downstream component tooling).

## Tests

```bash
bash tests/run-tests.sh
```

Thirteen golden-file checks across the emission matrix (formats, responsive strategies, skip handling, config validation). `STYLELINT_DIR=<dir with stylelint>` adds a lint pass; `UPDATE_GOLDEN=1` re-blesses goldens after an intentional emission change - eyeball the diff, never bless blind.

Runs on any maintained Node LTS (pure stdlib, no dependencies).

## License

[MIT](LICENSE)
