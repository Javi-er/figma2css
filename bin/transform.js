#!/usr/bin/env node
'use strict';

/**
 * figma2css transformer
 * ----------------------------------------------------------------------------
 * Reads raw Figma data (Variables + TextStyles) as produced by the
 * Raw Token Exporter Figma plugin and emits CSS:
 *
 *   - A `:root { … }` block of custom properties (from Variables).
 *   - One CSS class per TextStyle (e.g. `.text-heading-lg { … }`).
 *
 * Design decisions:
 *   - Pure stdlib Node. No deps. Runs anywhere a recent Node does.
 *   - Aliases are preserved as `var(--…)` references - never flattened.
 *   - Units are picked from each variable's `scopes` array, not from
 *     the variable's type alone. That keeps `font-weight: 400` from
 *     becoming `font-weight: 400px`.
 *   - Multi-mode collections emit one section per mode, with a
 *     `-{slugified-mode}` suffix on non-default modes.
 *   - TextStyles use `boundVariables` to prefer `var(--…)` references for
 *     any field bound to a Variable; literal values otherwise.
 *   - The CLI emits to stdout only. Writing to a host CSS file (with
 *     managed-region splicing) is the SKILL's job, not the script's -
 *     a deliberate footgun-prevention measure.
 */

const fs = require('fs');
const path = require('path');

// === Version ===============================================================

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}
const VERSION = readVersion();

// === Defaults ==============================================================
// All keys may be overridden by tokens.config.json. `scope_units` and
// `managed_region` deep-merge (per-key) rather than replacing wholesale.

const VALID_UNITS = new Set([
  'unitless', 'px', 'rem', 'em',
  'auto-line-height', 'auto-letter-spacing',
]);

const DEFAULTS = {
  indent: '  ',
  unit_base: 16,
  default_unit: 'rem',
  px_hints: true,
  managed_region: { start: '/* TOKENS:START */', end: '/* TOKENS:END */' },
  text_style_prefix: '',  // .heading-lg, .body-md, etc. (matches the
                          // SCSS @mixin convention many Drupal themes already use).

  // Map from Figma `VariableScope` to emitted CSS unit. Anything not listed
  // falls through to `default_unit`.
  scope_units: {
    FONT_WEIGHT: 'unitless',         // The headline bug fix: 400, not 400px.
    OPACITY: 'unitless',
    LINE_HEIGHT: 'auto-line-height',
    LETTER_SPACING: 'auto-letter-spacing',
    FONT_SIZE: 'rem',
    CORNER_RADIUS: 'px',
    WIDTH_HEIGHT: 'rem',
    GAP: 'rem',
    PARAGRAPH_SPACING: 'rem',
    PARAGRAPH_INDENT: 'rem',
    STROKE_FLOAT: 'px',
    EFFECT_FLOAT: 'px',
  },
};

// === CLI plumbing ==========================================================

function parseArgs(argv) {
  const args = { input: null, config: null, diff: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') args.input = argv[++i];
    else if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--diff' || a === '-d') args.diff = argv[++i];
    else if (a === '--emit' || a === '-e') args.emit = argv[++i];
    else if (a === '--version' || a === '-v') { process.stdout.write(`figma2css v${VERSION}\n`); process.exit(0); }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    `figma2css v${VERSION} - Figma Variables + TextStyles → CSS.`,
    '',
    'Usage:',
    '  node transform.js --input figma.json --config tokens.config.json > tokens.css',
    '  cat figma.json | node transform.js --config tokens.config.json > tokens.css',
    '',
    'Options:',
    '  -i, --input    Path to the Figma plugin JSON. Reads stdin if omitted.',
    '  -c, --config   Path to tokens.config.json. Optional; defaults applied if omitted.',
    '  -d, --diff     Path to an existing tokens.css. When set, prints a structured',
    '                 diff summary to stderr (added/removed/changed tokens) before the',
    '                 generated output is written. Does NOT modify stdout - the summary',
    '                 is for visibility, not merging. Output is always deterministic;',
    '                 the natural git diff handles the actual file change.',
    '  -e, --emit     Which emission goes to stdout: all (default; tokens + text',
    '                 styles, legacy combined), tokens (the :root block only), or',
    '                 text-styles (typography only - classes, mixins, or both per',
    '                 config.text_styles_format). Use tokens + text-styles in two',
    '                 runs to split typography into its own file.',
    '  -v, --version  Print version and exit.',
    '  -h, --help     Print this help and exit.',
    '',
    'Output is always written to stdout. To splice into a host CSS file (preserving',
    'content outside the managed-region markers), use the Claude Code skill - that\'s',
    'what the skill exists for.',
    '',
  ].join('\n'));
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// === Config validation =====================================================

/**
 * Validate user-supplied config. Returns an array of error strings; empty
 * means valid. Fail-fast on:
 *   - default_unit not in VALID_UNITS
 *   - scope_units values not in VALID_UNITS
 *   - non-string title / collection / mode in sections
 */
function validateConfig(config) {
  const errors = [];
  if (!VALID_UNITS.has(config.default_unit)) {
    errors.push(`default_unit "${config.default_unit}" is not one of: ${[...VALID_UNITS].join(', ')}`);
  }
  for (const [scope, unit] of Object.entries(config.scope_units || {})) {
    if (!VALID_UNITS.has(unit)) {
      errors.push(`scope_units.${scope} "${unit}" is not one of: ${[...VALID_UNITS].join(', ')}`);
    }
  }
  if (typeof config.text_style_prefix !== 'string') {
    errors.push(`text_style_prefix must be a string (got ${typeof config.text_style_prefix})`);
  }
  if (config.skip_collections !== undefined) {
    if (!Array.isArray(config.skip_collections) || config.skip_collections.some(s => typeof s !== 'string')) {
      errors.push('skip_collections must be an array of collection-name strings (exact match)');
    }
  }
  if (config.text_styles_format !== undefined
      && !['css-classes', 'scss-mixins', 'both'].includes(config.text_styles_format)) {
    errors.push(`text_styles_format "${config.text_styles_format}" must be one of: css-classes, scss-mixins, both`);
  }
  if (config.text_styles_output !== undefined && typeof config.text_styles_output !== 'string') {
    errors.push('text_styles_output must be a string path');
  }
  if (config.text_styles_responsive !== undefined) {
    const r = config.text_styles_responsive;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) {
      errors.push('text_styles_responsive must be an object: { "strategy": "stepped"|"fluid", "switch": "<n>em" }');
    } else {
      if (!['stepped', 'fluid'].includes(r.strategy)) {
        errors.push(`text_styles_responsive.strategy "${r.strategy}" must be one of: stepped, fluid`);
      }
      if (r.strategy === 'stepped'
          && (typeof r.switch !== 'string' || !/^\d+(\.\d+)?(em|px)$/.test(r.switch))) {
        errors.push('text_styles_responsive.switch must be a length like "48em" or "768px". rem is rejected: in @media, rem resolves against the browser default (16px), not the theme root.');
      }
    }
  }
  return errors;
}

// === Name conversion =======================================================

/** Kebab-case slug suitable for a CSS identifier body. */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\//g, '-')        // Figma uses `/` as the UI group separator.
    .replace(/\s+/g, '-')       // "warm gray" → "warm-gray"
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '') // Strip punctuation, emoji, etc.
    .replace(/-+/g, '-')        // Collapse runs from prior steps.
    .replace(/^-|-$/g, '');     // Trim ends.
}

/** Slugify a mode name; strips parenthetical viewport sizes. */
function slugifyMode(modeName) {
  const cleaned = modeName.replace(/\([^)]*\)/g, '').trim();
  return slugify(cleaned);
}

/** Viewport anchor in px parsed from a mode name like "Min (375px)"; null if absent. */
function modeAnchorPx(modeName) {
  const m = modeName.match(/\((\d+(?:\.\d+)?)\s*px\)/i);
  return m ? Number(m[1]) : null;
}

/**
 * CSS custom property name for a variable. Honors `codeSyntax.WEB` if set
 * by the designer; otherwise slugifies the Figma name.
 */
function cssNameForVariable(v) {
  if (v.codeSyntax && v.codeSyntax.WEB) {
    const w = v.codeSyntax.WEB.replace(/^-{0,2}/, '');
    return `--${w}`;
  }
  return `--${slugify(v.name)}`;
}

// === Value formatting (Variables) ==========================================

/** RGBA (channels 0–1) → CSS color string. */
function formatColor(rgba) {
  const { r, g, b, a } = rgba;
  const to = c => Math.round(c * 255).toString(16).padStart(2, '0');
  // Shorten #rrggbb / #rrggbbaa to #rgb / #rgba when every pair is doubled.
  // Keeps the emission clean under stylelint-config-standard
  // (color-hex-length: short). Deterministic: same input, same short form.
  const shorten = hex => {
    const body = hex.slice(1);
    let short = '#';
    for (let i = 0; i < body.length; i += 2) {
      if (body[i] !== body[i + 1]) return hex;
      short += body[i];
    }
    return short;
  };
  if (a === undefined || a === 1) return shorten(`#${to(r)}${to(g)}${to(b)}`);
  if (a === 0) return shorten(`#${to(r)}${to(g)}${to(b)}00`);
  // Percentage alpha per alpha-value-notation: percentage (the
  // stylelint-config-standard default). Up to two decimals, deterministic.
  const pct = Math.round(a * 10000) / 100;
  return `rgb(${Math.round(r*255)} ${Math.round(g*255)} ${Math.round(b*255)} / ${pct}%)`;
}

/** Pick the right unit for a FLOAT variable based on its scopes. */
function decideUnit(scopes, config) {
  if (!scopes || scopes.length === 0) return config.default_unit;
  if (scopes.length === 1 && scopes[0] === 'ALL_SCOPES') return config.default_unit;
  for (const scope of scopes) {
    if (scope === 'ALL_SCOPES') continue;
    if (config.scope_units[scope]) return config.scope_units[scope];
  }
  return config.default_unit;
}

// Truncate to 4 decimals; avoids JS float noise like 0.5000000000000001.
function trimDecimals(n) {
  return (Math.round(n * 10000) / 10000).toString();
}

function formatFloat(value, scopes, config) {
  const unit = decideUnit(scopes, config);
  return formatNumberWithUnit(value, unit, config);
}

/** Apply a chosen unit to a number. Used by both formatFloat and TextStyles. */
function formatNumberWithUnit(value, unit, config) {
  switch (unit) {
    case 'unitless':
      return String(value);
    case 'px':
      return `${value}px`;
    case 'rem':
      return `${trimDecimals(value / config.unit_base)}rem`;
    case 'em':
      return `${trimDecimals(value)}em`;
    case 'auto-line-height':
      return value < 4 ? String(value) : `${value}px`;
    case 'auto-letter-spacing':
      return Math.abs(value) < 1 ? `${trimDecimals(value)}em` : `${value}px`;
    default:
      return String(value);
  }
}

function pxHint(value, unit) {
  if (unit !== 'rem') return '';
  return ` /* ${value}px */`;
}

/**
 * Emit RHS value for one variable in a given mode.
 * Returns { value, hint } so the caller renders `${name}: ${value};${hint}`.
 */
function emitValue(variable, modeId, idToName, config) {
  const raw = variable.valuesByMode[modeId];

  if (raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') {
    const targetName = idToName.get(raw.id);
    if (!targetName) return { value: '/* alias-target-not-found */', hint: '' };
    return { value: `var(${targetName})`, hint: '' };
  }
  if (variable.resolvedType === 'COLOR' && raw && typeof raw === 'object') {
    return { value: formatColor(raw), hint: '' };
  }
  if (variable.resolvedType === 'STRING') {
    return { value: JSON.stringify(raw), hint: '' };
  }
  if (variable.resolvedType === 'BOOLEAN') {
    return { value: raw ? '1' : '0', hint: '' };
  }
  if (variable.resolvedType === 'FLOAT' && typeof raw === 'number') {
    const unit = decideUnit(variable.scopes, config);
    return {
      value: formatFloat(raw, variable.scopes, config),
      hint: config.px_hints ? pxHint(raw, unit) : '',
    };
  }
  return { value: '/* unknown */', hint: '' };
}

// === Collection / section helpers ==========================================

/**
 * Build Map<variableId, "--css-name"> AND detect collisions.
 * Two variables that slugify to the same CSS name are a real problem
 * (the later declaration silently overrides the earlier in the same scope).
 * We emit a warning so the dev can rename one of them in Figma.
 */
function buildIdToCssName(variables, warnings) {
  const idToName = new Map();
  const nameToVars = new Map();
  for (const v of variables) {
    const cssName = cssNameForVariable(v);
    idToName.set(v.id, cssName);
    if (!nameToVars.has(cssName)) nameToVars.set(cssName, []);
    nameToVars.get(cssName).push(v);
  }
  for (const [cssName, vars] of nameToVars) {
    if (vars.length > 1) {
      const sources = vars.map(v => `"${v.name}"`).join(', ');
      warnings.push(`Name collision: ${cssName} ← ${sources}. Later wins; rename one in Figma.`);
    }
  }
  return idToName;
}

/** Build Map<variableId, variable> for O(1) lookup in emitSection. */
function buildIdToVariable(variables) {
  const map = new Map();
  for (const v of variables) map.set(v.id, v);
  return map;
}

function extractLeadingNumber(name) {
  const m = name.match(/^(\d+)\./);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Sort collections for output. Collections with a leading number
 * ("01.", "02.", …) sort numerically; unnumbered collections come first in
 * their original Figma order. Most teams use a `NN.` prefix on their
 * collection names to encode output order.
 */
function sortCollections(collections) {
  return [...collections].sort((a, b) => {
    const an = extractLeadingNumber(a.name);
    const bn = extractLeadingNumber(b.name);
    if (an != null && bn != null) return an - bn;
    if (an != null) return 1;
    if (bn != null) return -1;
    return 0;
  });
}

/**
 * Emit one section's CSS lines for a (collection, mode) pair.
 *   - `title`: section comment text.
 *   - `modeSuffix`: appended to every variable name when emitting a
 *     non-default mode (so the two modes don't collide in the same `:root`).
 */
function emitSection(title, collection, modeId, modeSuffix, idToVariable, idToName, config) {
  const lines = [`${config.indent}/* ${title} */`];
  for (const id of collection.variableIds) {
    const v = idToVariable.get(id);
    if (!v) continue;
    if (v.valuesByMode[modeId] === undefined) continue;
    const finalName = idToName.get(v.id) + modeSuffix;
    const { value, hint } = emitValue(v, modeId, idToName, config);
    lines.push(`${config.indent}${finalName}: ${value};${hint}`);
  }
  return lines.join('\n') + '\n';
}

// === TextStyles → CSS classes =============================================

/**
 * Parse a Figma fontName.style string into a CSS font-weight number and an
 * italic boolean. Examples:
 *   "Regular"      → { weight: 400, italic: false }
 *   "Bold"         → { weight: 700, italic: false }
 *   "Bold Italic"  → { weight: 700, italic: true }
 *   "Semi Bold"    → { weight: 600, italic: false }
 *   "ExtraLight"   → { weight: 200, italic: false }
 * Falls back to 400 + non-italic when the style is unrecognized.
 */
function parseFontStyle(styleStr) {
  if (!styleStr) return { weight: 400, italic: false };
  const s = styleStr.toLowerCase();
  const italic = /italic|oblique/.test(s);
  // Match longest names first so "extra bold" beats "bold".
  const weightMap = [
    [/extra ?light|ultra ?light/, 200],
    [/semi ?bold|demi ?bold/, 600],
    [/extra ?bold|ultra ?bold/, 800],
    [/thin|hairline/, 100],
    [/light/, 300],
    [/medium/, 500],
    [/black|heavy/, 900],
    [/bold/, 700],
    [/regular|normal|book/, 400],
  ];
  for (const [re, w] of weightMap) {
    if (re.test(s)) return { weight: w, italic };
  }
  return { weight: 400, italic };
}

/** TextStyle.lineHeight → CSS line-height string. */
function formatLineHeight(lh, config) {
  if (!lh || lh.unit === 'AUTO') return 'normal';
  if (lh.unit === 'PERCENT') return trimDecimals(lh.value / 100);
  if (lh.unit === 'PIXELS') return `${lh.value}px`;
  return 'normal';
}

/** TextStyle.letterSpacing → CSS letter-spacing string. */
function formatLetterSpacing(ls) {
  if (!ls) return '0';
  if (ls.unit === 'PERCENT') return `${trimDecimals(ls.value / 100)}em`;
  if (ls.unit === 'PIXELS') return `${ls.value}px`;
  return '0';
}

const TEXT_CASE_MAP = {
  ORIGINAL: null,
  UPPER: 'uppercase',
  LOWER: 'lowercase',
  TITLE: 'capitalize',
  SMALL_CAPS: 'small-caps',          // → font-variant-caps
  SMALL_CAPS_FORCED: 'all-small-caps',
};

const TEXT_DECORATION_MAP = {
  NONE: null,
  UNDERLINE: 'underline',
  STRIKETHROUGH: 'line-through',
};

const GENERIC_FONT_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math',
]);

/**
 * Pick a generic fallback keyword for a family name. Heuristic on the name
 * (deterministic): mono/code cues -> monospace, serif without a sans cue ->
 * serif, everything else -> sans-serif. Satisfies
 * font-family-no-missing-generic-family-keyword; the user can hand-tune the
 * fallback outside the managed region if the guess is wrong for their font.
 */
function genericFamilyFor(name) {
  if (/mono|code|consol/i.test(name)) return 'monospace';
  if (/serif/i.test(name) && !/sans/i.test(name)) return 'serif';
  return 'sans-serif';
}

/**
 * Format a font-family value: the name (quoted only when it contains
 * whitespace, digits, or punctuation, per font-family-name-quotes:
 * always-where-recommended) plus a generic fallback keyword.
 */
function formatFontFamily(name) {
  const safeUnquoted = /^[A-Za-z][A-Za-z-]*$/.test(name)
    && !GENERIC_FONT_FAMILIES.has(name.toLowerCase());
  const quoted = safeUnquoted ? name : JSON.stringify(name);
  return `${quoted}, ${genericFamilyFor(name)}`;
}

/**
 * Emit one CSS class for a TextStyle. Prefers `var(--…)` references for any
 * field with a bound variable; uses literal values otherwise.
 */
/**
 * Build the property lines (indented, no braces) for one TextStyle.
 * Shared by the class / mixin / both emission formats.
 */
function buildTextStyleBody(style, idToName, config, ctx) {
  const lines = [];
  const overrides = [];
  const bound = style.boundVariables || {};

  // Bound numeric fields: var() reference, or the responsive form when the
  // bound variable lives in a two-mode viewport collection (ctx). Stepped
  // pushes the large-viewport declaration into `overrides`; fluid returns a
  // self-contained clamp(). Falls back to the literal when unbound/unknown.
  const valueFor = (field, cssProp, literal) => {
    const b = bound[field];
    if (b && b.id) {
      const target = idToName.get(b.id);
      if (target) {
        const r = ctx ? ctx.forVariable(b.id, target) : null;
        if (r && r.kind === 'fluid') return r.value;
        if (r && r.kind === 'stepped') {
          overrides.push(`${cssProp}: ${r.override};`);
          return r.base;
        }
        return `var(${target})`;
      }
    }
    return literal;
  };

  // Font family (generic fallback appended even after a var() reference;
  // STRING variables are never responsive)
  const familyTarget = bound.fontFamily && bound.fontFamily.id
    ? idToName.get(bound.fontFamily.id)
    : null;
  const family = familyTarget
    ? `var(${familyTarget}), ${genericFamilyFor(style.fontName.family)}`
    : formatFontFamily(style.fontName.family);
  lines.push(`${config.indent}font-family: ${family};`);

  // Font weight (from style string, unless bound)
  const parsed = parseFontStyle(style.fontName.style);
  const weight = valueFor('fontWeight', 'font-weight', String(parsed.weight));
  lines.push(`${config.indent}font-weight: ${weight};`);

  // Font style (italic from name, no separate bind in most cases)
  if (parsed.italic) lines.push(`${config.indent}font-style: italic;`);

  // Font size
  const fontSize = valueFor('fontSize', 'font-size',
    formatNumberWithUnit(style.fontSize, 'rem', config));
  lines.push(`${config.indent}font-size: ${fontSize};`);

  // Line height
  const lineHeight = valueFor('lineHeight', 'line-height',
    formatLineHeight(style.lineHeight, config));
  lines.push(`${config.indent}line-height: ${lineHeight};`);

  // Letter spacing (skip if zero with no binding)
  const hasLetterSpacing = (style.letterSpacing && style.letterSpacing.value !== 0) || (bound.letterSpacing && bound.letterSpacing.id);
  if (hasLetterSpacing) {
    const ls = valueFor('letterSpacing', 'letter-spacing',
      formatLetterSpacing(style.letterSpacing));
    lines.push(`${config.indent}letter-spacing: ${ls};`);
  }

  // Text case
  if (style.textCase && TEXT_CASE_MAP[style.textCase]) {
    const v = TEXT_CASE_MAP[style.textCase];
    if (style.textCase === 'SMALL_CAPS' || style.textCase === 'SMALL_CAPS_FORCED') {
      lines.push(`${config.indent}font-variant-caps: ${v};`);
    } else {
      lines.push(`${config.indent}text-transform: ${v};`);
    }
  }

  // Text decoration
  if (style.textDecoration && TEXT_DECORATION_MAP[style.textDecoration]) {
    lines.push(`${config.indent}text-decoration: ${TEXT_DECORATION_MAP[style.textDecoration]};`);
  }

  return { lines, overrides };
}

/**
 * Per-variable responsive lookup for text-style emission, driven by
 * config.text_styles_responsive. Applies to variables in two-mode
 * collections whose values differ between the modes. Base = the
 * smaller-viewport mode (px anchor parsed from the mode name, e.g.
 * "Min (375px)"; stepped falls back to the non-default mode when anchors
 * are missing); override = the larger-viewport mode. Variable-name
 * suffixes mirror buildRoot's emission (default mode unsuffixed, others
 * -slugifyMode(name)), so the emitted var() references always resolve.
 */
function buildResponsiveContext(dump, config, warnings) {
  const rc = config.text_styles_responsive;
  if (!rc || !rc.strategy) return null;

  const idToVariable = buildIdToVariable(dump.variables);
  const collectionById = new Map(dump.collections.map(c => [c.id, c]));
  const plans = new Map();

  function planFor(collection) {
    if (plans.has(collection.id)) return plans.get(collection.id);
    let plan = null;
    if (collection.modes.length === 2) {
      const [a, b] = collection.modes;
      const anchorA = modeAnchorPx(a.name);
      const anchorB = modeAnchorPx(b.name);
      let small = null;
      let large = null;
      if (anchorA !== null && anchorB !== null && anchorA !== anchorB) {
        [small, large] = anchorA < anchorB ? [a, b] : [b, a];
      } else if (rc.strategy === 'stepped') {
        // No px anchors: assume the non-default mode is the small viewport
        // (the observed convention: default mode = Max/Desktop).
        small = collection.modes.find(m => m.modeId !== collection.defaultModeId);
        large = collection.modes.find(m => m.modeId === collection.defaultModeId);
        warnings.push(`Responsive text styles: collection "${collection.name}" has no (Npx) anchors in its mode names; assuming non-default mode "${small.name}" is the small viewport.`);
      } else {
        warnings.push(`Responsive text styles: collection "${collection.name}" has no (Npx) viewport anchors in its mode names. Fluid needs both anchors; emitting non-responsive values for this collection.`);
      }
      if (small && large) {
        const suffix = m => (m.modeId === collection.defaultModeId ? '' : `-${slugifyMode(m.name)}`);
        plan = {
          small,
          large,
          smallSuffix: suffix(small),
          largeSuffix: suffix(large),
          vwMin: anchorA !== null && anchorB !== null ? Math.min(anchorA, anchorB) : null,
          vwMax: anchorA !== null && anchorB !== null ? Math.max(anchorA, anchorB) : null,
        };
      }
    }
    plans.set(collection.id, plan);
    return plan;
  }

  // Resolve a variable to a number in a mode, following aliases. Cross-
  // collection hops keep the mode when the target collection has it,
  // otherwise use that collection's default mode.
  function resolveNumber(varId, modeId, depth) {
    if (depth > 10) return null;
    const v = idToVariable.get(varId);
    if (!v) return null;
    const c = collectionById.get(v.variableCollectionId);
    const useMode = v.valuesByMode[modeId] !== undefined ? modeId : (c ? c.defaultModeId : modeId);
    const raw = v.valuesByMode[useMode];
    if (raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') {
      return resolveNumber(raw.id, useMode, depth + 1);
    }
    return typeof raw === 'number' ? raw : null;
  }

  return {
    strategy: rc.strategy,
    switch: rc.switch,
    scssTarget: /\.scss$/.test(config.text_styles_output || config.output || ''),
    forVariable(varId, cssName) {
      const v = idToVariable.get(varId);
      if (!v) return null;
      const c = collectionById.get(v.variableCollectionId);
      if (!c) return null;
      const plan = planFor(c);
      if (!plan) return null;
      const smallRaw = v.valuesByMode[plan.small.modeId];
      const largeRaw = v.valuesByMode[plan.large.modeId];
      if (smallRaw === undefined || largeRaw === undefined) return null;
      if (JSON.stringify(smallRaw) === JSON.stringify(largeRaw)) return null;
      if (rc.strategy === 'fluid') {
        if (plan.vwMin === null) return null;
        const min = resolveNumber(varId, plan.small.modeId, 0);
        const max = resolveNumber(varId, plan.large.modeId, 0);
        if (min === null || max === null) return null;
        const slope = (max - min) / (plan.vwMax - plan.vwMin);
        const intercept = min - slope * plan.vwMin;
        const rem = n => `${trimDecimals(n / config.unit_base)}rem`;
        return {
          kind: 'fluid',
          value: `clamp(${rem(Math.min(min, max))}, ${rem(intercept)} + ${trimDecimals(slope * 100)}vw, ${rem(Math.max(min, max))})`,
        };
      }
      return {
        kind: 'stepped',
        base: `var(${cssName}${plan.smallSuffix})`,
        override: `var(${cssName}${plan.largeSuffix})`,
      };
    },
  };
}

/**
 * Emit one TextStyle in the configured format (config.text_styles_format):
 *   "css-classes" (default) - `.name { … }` (legacy behavior)
 *   "scss-mixins"           - `@mixin name { … }` (Sass source only)
 *   "both"                  - the mixin + a class that `@include`s it
 * The mixin name equals the class name, so the SDC scaffolder's
 * utility-class manifest maps either way.
 */
function emitTextStyle(style, idToName, config, ctx, trailing) {
  const name = `${config.text_style_prefix}${slugify(style.name)}`;
  const { lines, overrides } = buildTextStyleBody(style, idToName, config, ctx);
  const body = lines.join('\n');
  const format = config.text_styles_format || 'css-classes';
  const i = config.indent;

  // Stepped overrides nest a media query inside the mixin (and inside the
  // class on Sass targets). Plain-CSS class output can't nest, so those
  // overrides accumulate into one trailing @media block instead.
  const mediaInner = overrides.length && ctx && ctx.strategy === 'stepped'
    ? `\n\n${i}@media (width >= ${ctx.switch}) {\n${overrides.map(o => `${i}${i}${o}`).join('\n')}\n${i}}`
    : '';

  const parts = [];
  if (format === 'scss-mixins' || format === 'both') {
    parts.push(`@mixin ${name} {\n${body}${mediaInner}\n}\n`);
  }
  if (format === 'css-classes') {
    if (mediaInner && ctx.scssTarget) {
      parts.push(`.${name} {\n${body}${mediaInner}\n}\n`);
    } else {
      parts.push(`.${name} {\n${body}\n}\n`);
      if (mediaInner) {
        trailing.push(`${i}.${name} {\n${overrides.map(o => `${i}${i}${o}`).join('\n')}\n${i}}`);
      }
    }
  } else if (format === 'both') {
    parts.push(`.${name} {\n${i}@include ${name};\n}\n`);
  }
  // Blank line between the mixin and its companion class
  // (rule-empty-line-before in stylelint-config-standard).
  return parts.join('\n');
}

// === Driver building =======================================================

function buildRoot(dump, config, warnings) {
  const idToName = buildIdToCssName(dump.variables, warnings);
  const idToVariable = buildIdToVariable(dump.variables);

  // Collections excluded via config.skip_collections (exact-name match).
  // Designers mark non-exportable collections by convention (e.g.
  // "Utility (do not export)"); the skill detects those names and asks the
  // user before writing them into this config.
  const skipNames = new Set(config.skip_collections || []);
  const allCollections = sortCollections(dump.collections);
  const skippedCollections = allCollections.filter(c => skipNames.has(c.name));
  const collections = allCollections.filter(c => !skipNames.has(c.name));

  for (const name of skipNames) {
    if (!allCollections.some(c => c.name === name)) {
      warnings.push(`skip_collections entry "${name}" matches no collection in the dump (names are exact-match).`);
    }
  }

  if (skippedCollections.length > 0) {
    process.stderr.write(`Skipped collections (per skip_collections): ${skippedCollections.map(c => `"${c.name}"`).join(', ')}\n`);

    // Dangling-alias check: a variable in an EXPORTED collection that
    // aliases into a SKIPPED collection would emit `var(--x)` for a custom
    // property that's never declared - broken at runtime, silently. Warn
    // per unique (source → target) pair so the user can either unskip the
    // collection or fix the alias in Figma.
    const skippedIds = new Set();
    for (const c of skippedCollections) for (const id of c.variableIds) skippedIds.add(id);
    const keptIds = new Set();
    for (const c of collections) for (const id of c.variableIds) keptIds.add(id);

    const seen = new Set();
    for (const v of dump.variables) {
      if (!keptIds.has(v.id)) continue;
      for (const raw of Object.values(v.valuesByMode || {})) {
        if (raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS' && skippedIds.has(raw.id)) {
          const target = idToVariable.get(raw.id);
          const key = `${v.name}→${target ? target.name : raw.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          warnings.push(`Dangling alias: exported "${v.name}" references "${target ? target.name : raw.id}" in a skipped collection - the emitted var() will not resolve. Unskip the collection or fix the alias in Figma.`);
        }
      }
    }
  }

  const sections = [];
  for (const c of collections) {
    if (c.modes.length <= 1) {
      sections.push(emitSection(c.name, c, c.defaultModeId, '', idToVariable, idToName, config));
    } else {
      // Default mode first; the rest in their Figma order.
      const ordered = [...c.modes].sort((a, b) => {
        if (a.modeId === c.defaultModeId) return -1;
        if (b.modeId === c.defaultModeId) return 1;
        return 0;
      });
      for (const m of ordered) {
        const isDefault = m.modeId === c.defaultModeId;
        const title = `${c.name}: ${m.name}`;
        const suffix = isDefault ? '' : `-${slugifyMode(m.name)}`;
        sections.push(emitSection(title, c, m.modeId, suffix, idToVariable, idToName, config));
      }
    }
  }
  return { rootBlock: `:root {\n${sections.join('\n')}}\n`, idToName };
}

function buildTextStyles(dump, idToName, config, warnings) {
  const styles = Array.isArray(dump.textStyles) ? dump.textStyles : [];
  if (styles.length === 0) return '';
  const ctx = buildResponsiveContext(dump, config, warnings);
  const trailing = [];
  const classes = styles.map(s => emitTextStyle(s, idToName, config, ctx, trailing));
  let out = `\n/* Text styles */\n${classes.join('\n')}`;
  if (trailing.length > 0) {
    out += `\n@media (width >= ${ctx.switch}) {\n${trailing.join('\n\n')}\n}\n`;
  }
  return out;
}

// === Diff summary (visibility, not merging) ================================

/**
 * Extract CSS custom property declarations from a CSS source. Returns a
 * Map<name, value> where name is the leading dashes form (--foo-bar) and
 * value is the trimmed RHS (everything after the colon, before the
 * terminating semicolon).
 *
 * Robust to indentation, comments interspersed between declarations, and
 * mode-suffix sibling sections - it just collects every line shaped like
 * `--name: value;`. Order is preserved (insertion order = file order).
 */
function parseCustomProperties(css) {
  const map = new Map();
  if (!css) return map;
  // Match `--name: value;` allowing whitespace, multi-line values terminated
  // by a semicolon. Conservative: doesn't try to handle nested parens
  // beyond one level (which covers the rgb()/var() cases we emit).
  const re = /(--[a-z0-9_-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(css)) !== null) {
    const name = m[1];
    const value = m[2].trim().replace(/\s+/g, ' ');
    map.set(name, value);
  }
  return map;
}

/**
 * Extract top-level style blocks - `.name { … }` classes and
 * `@mixin name { … }` Sass mixins - from a CSS/SCSS source. Returns
 * Map<displayName, normalizedBody> where displayName keeps its sigil
 * (".headings-heading-xl" / "@mixin headings-heading-xl") and body
 * whitespace is collapsed so formatting-only differences don't read as
 * changes. Brace-counting walk, so a stray `{` in a content string won't
 * derail it for the shapes this transformer emits.
 *
 * Used by --diff when --emit text-styles: the typography file's managed
 * region holds blocks, not custom properties, so parseCustomProperties
 * would report a useless "no changes" there.
 */
function parseStyleBlocks(css) {
  const map = new Map();
  if (!css) return map;
  // Ranges of top-level @media blocks: class blocks inside them (the
  // plain-CSS stepped-override emission) get an "@media" key suffix so the
  // base block and its override diff independently instead of colliding.
  const mediaRanges = [];
  const mediaRe = /@media[^{]*\{/g;
  let mm;
  while ((mm = mediaRe.exec(css)) !== null) {
    let depth = 1;
    let j = mediaRe.lastIndex;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    mediaRanges.push([mediaRe.lastIndex, j]);
  }
  const inMedia = idx => mediaRanges.some(([s, e]) => idx >= s && idx < e);
  const headerRe = /(\.[a-z][a-z0-9_-]*|@mixin\s+[a-z][a-z0-9_-]*)\s*\{/gi;
  let m;
  while ((m = headerRe.exec(css)) !== null) {
    const name = m[1].replace(/\s+/g, ' ').trim() + (inMedia(m.index) ? '@media' : '');
    let depth = 1;
    let i = headerRe.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const body = css.slice(headerRe.lastIndex, i - 1).trim().replace(/\s+/g, ' ');
    map.set(name, body);
    headerRe.lastIndex = i;
  }
  return map;
}

/**
 * Extract the content of the managed region between START / END markers
 * from a tokens.css source. Returns the empty string if either marker is
 * absent (treats the whole file as managed in that case - same fallback the
 * skill's splice logic uses).
 */
function extractManagedRegion(css, startMarker, endMarker) {
  if (!css) return '';
  const startIdx = css.indexOf(startMarker);
  const endIdx = css.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return css; // No markers - treat the whole file as managed.
  }
  return css.slice(startIdx + startMarker.length, endIdx);
}

/**
 * Compute a structured diff between two CSS-custom-property maps.
 * Returns { added: [{name, value}], removed: [{name, value}],
 *           changed: [{name, before, after}], unchanged: number }.
 */
function diffTokenMaps(existingMap, newMap) {
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const [name, value] of newMap) {
    if (!existingMap.has(name)) {
      added.push({ name, value });
    } else if (existingMap.get(name) !== value) {
      changed.push({ name, before: existingMap.get(name), after: value });
    } else {
      unchanged++;
    }
  }
  for (const [name, value] of existingMap) {
    if (!newMap.has(name)) {
      removed.push({ name, value });
    }
  }
  return { added, removed, changed, unchanged };
}

/**
 * Format the diff summary as a human-readable block written to stderr.
 * Caps each list at 20 entries to avoid wall-of-text on first-time exports.
 */
function formatDiffSummary(diff, noun = 'tokens') {
  const lines = [];
  const totalChanges = diff.added.length + diff.removed.length + diff.changed.length;
  if (totalChanges === 0) {
    lines.push(`Diff summary: no changes (${diff.unchanged} ${noun} unchanged).`);
    return lines.join('\n') + '\n';
  }
  lines.push(`Diff summary: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed (${diff.unchanged} unchanged).`);
  const showSlice = (label, items, formatter) => {
    if (items.length === 0) return;
    lines.push('');
    lines.push(`  ${label} (${items.length}):`);
    const slice = items.slice(0, 20);
    for (const it of slice) lines.push('    ' + formatter(it));
    if (items.length > 20) lines.push(`    … and ${items.length - 20} more`);
  };
  showSlice('Changed', diff.changed, c => `${c.name}: ${c.before}  →  ${c.after}`);
  showSlice('Added',   diff.added,   a => `${a.name}: ${a.value}`);
  showSlice('Removed', diff.removed, r => `${r.name}: ${r.value}`);
  return lines.join('\n') + '\n';
}

// === Driver ================================================================

async function main() {
  const args = parseArgs(process.argv);

  let userConfig = {};
  if (args.config) {
    try {
      const raw = fs.readFileSync(args.config, 'utf8').replace(/^﻿/, '');
      userConfig = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`Error reading config "${args.config}": ${e.message}\n`);
      process.exit(2);
    }
  }
  const config = {
    ...DEFAULTS,
    ...userConfig,
    scope_units: { ...DEFAULTS.scope_units, ...(userConfig.scope_units || {}) },
    managed_region: { ...DEFAULTS.managed_region, ...(userConfig.managed_region || {}) },
  };

  const configErrors = validateConfig(config);
  if (configErrors.length) {
    process.stderr.write('Config errors:\n' + configErrors.map(e => '  - ' + e).join('\n') + '\n');
    process.exit(2);
  }

  let inputRaw;
  if (args.input) {
    inputRaw = fs.readFileSync(args.input, 'utf8');
  } else {
    inputRaw = await readStdin();
  }
  inputRaw = inputRaw.replace(/^﻿/, ''); // Strip UTF-8 BOM if present.
  if (!inputRaw.trim()) {
    process.stderr.write('Error: no input. Provide --input <path> or pipe to stdin.\n');
    process.exit(2);
  }

  let dump;
  try {
    dump = JSON.parse(inputRaw);
  } catch (e) {
    process.stderr.write(`Error: input is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }

  if (!Array.isArray(dump.collections) || !Array.isArray(dump.variables)) {
    process.stderr.write('Error: input does not look like a Raw Token Exporter plugin dump (missing collections/variables arrays).\n');
    process.exit(2);
  }

  // --emit selects which half goes to stdout. `all` (default) is the legacy
  // combined emission; `tokens` / `text-styles` support splitting typography
  // into its own target file (config.text_styles_output) - the skill runs
  // the transformer once per target and splices each into its file.
  const emit = args.emit || 'all';
  if (!['all', 'tokens', 'text-styles'].includes(emit)) {
    process.stderr.write(`Error: --emit "${emit}" must be one of: all, tokens, text-styles\n`);
    process.exit(2);
  }

  const warnings = [];
  const { rootBlock, idToName } = buildRoot(dump, config, warnings);
  let newOutput;
  if (emit === 'tokens') {
    newOutput = rootBlock;
  } else if (emit === 'text-styles') {
    newOutput = buildTextStyles(dump, idToName, config, warnings).replace(/^\n/, '');
  } else {
    newOutput = rootBlock + buildTextStyles(dump, idToName, config, warnings);
  }

  // Diff summary - visibility only, doesn't modify the output.
  if (args.diff) {
    let existingCss = '';
    try {
      existingCss = fs.readFileSync(args.diff, 'utf8');
    } catch (e) {
      process.stderr.write(`Warning: --diff target "${args.diff}" not readable (${e.code || 'error'}); skipping diff summary.\n`);
    }
    if (existingCss) {
      const startMarker = config.managed_region && config.managed_region.start
        ? config.managed_region.start
        : '/* TOKENS:START */';
      const endMarker = config.managed_region && config.managed_region.end
        ? config.managed_region.end
        : '/* TOKENS:END */';
      const existingRegion = extractManagedRegion(existingCss, startMarker, endMarker);
      // Typography files hold style blocks (classes / mixins), not custom
      // properties - pick the parser matching what's being emitted.
      const parse = emit === 'text-styles' ? parseStyleBlocks : parseCustomProperties;
      const existingMap = parse(existingRegion);
      const newMap = parse(newOutput);
      const diff = diffTokenMaps(existingMap, newMap);
      process.stderr.write(formatDiffSummary(diff, emit === 'text-styles' ? 'text styles' : 'tokens'));
    }
  }

  process.stdout.write(newOutput);

  if (warnings.length) {
    process.stderr.write('Warnings:\n' + warnings.map(w => '  - ' + w).join('\n') + '\n');
  }
}

main().catch(err => {
  process.stderr.write(`Unhandled: ${err.stack || err}\n`);
  process.exit(1);
});
