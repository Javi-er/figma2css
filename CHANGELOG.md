# Changelog

All notable changes to `figma2css`. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-10-29

### Fixed

- SKILL.md frontmatter is now strict-YAML valid (the description moved to a folded block scalar; the unquoted colons broke GitHub's frontmatter renderer, though lenient parsers accepted it).
- Drupal-specific scope removed or demoted to examples: the `<theme>.breakpoints.yml` scaffold is gone from the foundations step (platform config is the theme's concern, not this skill's), and `libraries.yml` / Drupal-shaped paths are now illustrative rather than mandated. Verified: harness 13/13, frontmatter parses under a strict YAML parser.

## [1.0.0] - 2026-10-29

First public release. Paired with the [Raw Token Exporter Figma plugin](https://www.figma.com/community/plugin/1697764012142993786/raw-token-exporter) on Figma Community.

- Figma Variables to CSS custom properties inside a managed region of your stylesheet (everything outside the markers is preserved); aliases preserved as `var()` references; units type-aware per Figma variable scope; multi-mode collections expanded with name suffixes; collections marked "do not export" skipped with dangling-alias warnings.
- TextStyles to utility classes, SCSS mixins, or both, with optional responsive typography (stepped breakpoints or fluid clamp).
- Layout foundations scaffold (breakpoints map, media/container query helpers) from Figma spacing variables.
- `bin/transform.js` is pure Node (no dependencies), byte-deterministic, with a `--diff` mode; the regression harness covers the emission matrix with golden files (13 checks).
- Smoke-tested for release: full harness pass after swapping fixture font families to open-source ones (`Space Grotesk`, `Public Sans`) and re-blessing goldens.
