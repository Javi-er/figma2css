#!/usr/bin/env bash
# Regression harness for bin/transform.js.
#
# Each case runs the transformer against a fixture + config and asserts:
#   1. determinism  - two runs produce byte-identical output (cmp)
#   2. regression   - output is byte-identical to the committed golden file
#   3. diff no-op   - the golden spliced between managed-region markers and
#                     fed back via --diff reports "no changes" (both parsers)
# Plus: invalid configs must exit nonzero naming the offending key, the
# skip-collections case must emit its three warnings, and (optionally) every
# golden must pass stylelint-config-standard / -scss.
#
# Usage:
#   tests/run-tests.sh                  run the suite
#   UPDATE_GOLDEN=1 tests/run-tests.sh  regenerate goldens (then eyeball the
#                                       git diff; goldens encode VERIFIED
#                                       behavior, never bless blind)
#   STYLELINT_DIR=/path tests/run-tests.sh
#       also lint goldens; the dir must hold node_modules with stylelint,
#       stylelint-config-standard and stylelint-config-standard-scss.
#
# Zero dependencies beyond bash + node (+ optional stylelint dir). Writes
# only to a mktemp scratch dir, removed on exit.

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRANSFORM="$TESTS_DIR/../bin/transform.js"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL %s: %s\n' "$1" "$2"; }

# name fixture config emit
run_case() {
  local name="$1" fixture="$2" config="$3" emit="$4"
  local golden="$TESTS_DIR/golden/$name.out"
  local out1="$SCRATCH/$name.1" out2="$SCRATCH/$name.2"

  if ! node "$TRANSFORM" -i "$TESTS_DIR/fixtures/$fixture" -c "$TESTS_DIR/configs/$config" --emit "$emit" >"$out1" 2>"$SCRATCH/$name.err"; then
    bad "$name" "transformer exited nonzero: $(head -2 "$SCRATCH/$name.err" | tr '\n' ' ')"
    return
  fi
  node "$TRANSFORM" -i "$TESTS_DIR/fixtures/$fixture" -c "$TESTS_DIR/configs/$config" --emit "$emit" >"$out2" 2>/dev/null

  if ! cmp -s "$out1" "$out2"; then
    bad "$name" "nondeterministic: two runs differ"
    return
  fi

  if [ "${UPDATE_GOLDEN:-0}" = "1" ]; then
    cp "$out1" "$golden"
    ok "$name (golden updated)"
    return
  fi

  if [ ! -f "$golden" ]; then
    bad "$name" "golden missing (run with UPDATE_GOLDEN=1 once)"
    return
  fi
  if ! cmp -s "$out1" "$golden"; then
    bad "$name" "output differs from golden (diff golden/$name.out vs fresh run)"
    diff "$golden" "$out1" | head -8 || true
    return
  fi

  # Diff no-op: splice the golden into a marker-managed file per the
  # SKILL.md step 4 spacing spec, then assert --diff reports no changes.
  local spliced="$SCRATCH/$name.spliced"
  {
    printf '/* TOKENS:START */\n\n'
    cat "$golden"
    printf '\n/* TOKENS:END */\n'
  } >"$spliced"
  node "$TRANSFORM" -i "$TESTS_DIR/fixtures/$fixture" -c "$TESTS_DIR/configs/$config" --emit "$emit" --diff "$spliced" >/dev/null 2>"$SCRATCH/$name.diff"
  if ! grep -q 'no changes' "$SCRATCH/$name.diff"; then
    bad "$name" "diff against own golden is not a no-op: $(grep 'Diff summary' "$SCRATCH/$name.diff" | head -1)"
    return
  fi

  ok "$name"
}

# name config expected-substring
run_invalid() {
  local name="$1" config="$2" expect="$3"
  if node "$TRANSFORM" -i "$TESTS_DIR/fixtures/core.json" -c "$TESTS_DIR/configs/$config" >/dev/null 2>"$SCRATCH/$name.err"; then
    bad "$name" "invalid config was accepted (exit 0)"
    return
  fi
  if ! grep -q "$expect" "$SCRATCH/$name.err"; then
    bad "$name" "error message lacks '$expect'"
    return
  fi
  ok "$name"
}

# --- Emission matrix ---------------------------------------------------------
run_case legacy-all          core.json legacy.json           all
run_case split-tokens        core.json split-scss-both.json  tokens
run_case split-text-both     core.json split-scss-both.json  text-styles
run_case mixins-only         core.json mixins-only.json      text-styles
run_case classes-css         core.json classes-css.json      text-styles
run_case resp-stepped-scss   core.json resp-stepped-scss.json text-styles
run_case resp-stepped-css    core.json resp-stepped-css.json text-styles
run_case resp-fluid          core.json resp-fluid.json       text-styles
run_case skip-tokens         skip.json skip.json             tokens

# --- Skip-collections warnings ----------------------------------------------
name=skip-warnings
node "$TRANSFORM" -i "$TESTS_DIR/fixtures/skip.json" -c "$TESTS_DIR/configs/skip.json" --emit tokens >/dev/null 2>"$SCRATCH/$name.err" || true
if grep -q 'Skipped collections' "$SCRATCH/$name.err" \
   && grep -q 'Dangling alias' "$SCRATCH/$name.err" \
   && grep -q 'matches no collection' "$SCRATCH/$name.err"; then
  ok "$name"
else
  bad "$name" "expected skip/dangling/unknown warnings on stderr"
fi

# --- Config validation -------------------------------------------------------
run_invalid invalid-rem-switch invalid-rem-switch.json 'rem is rejected'
run_invalid invalid-strategy   invalid-strategy.json   'stepped, fluid'
run_invalid invalid-format     invalid-format.json     'css-classes, scss-mixins, both'

# --- Optional stylelint pass over goldens ------------------------------------
if [ -n "${STYLELINT_DIR:-}" ] && [ -x "$STYLELINT_DIR/node_modules/.bin/stylelint" ]; then
  LINTDIR="$SCRATCH/lint"
  mkdir -p "$LINTDIR"
  for g in legacy-all split-tokens classes-css resp-stepped-css resp-fluid skip-tokens; do
    { printf '/* TOKENS:START */\n\n'; cat "$TESTS_DIR/golden/$g.out"; printf '\n/* TOKENS:END */\n'; } >"$LINTDIR/$g.css"
  done
  for g in split-text-both mixins-only resp-stepped-scss; do
    { printf '/* TOKENS:START */\n\n'; cat "$TESTS_DIR/golden/$g.out"; printf '\n/* TOKENS:END */\n'; } >"$LINTDIR/$g.scss"
  done
  printf '{"extends":["stylelint-config-standard"]}' >"$LINTDIR/.stylelintrc.json"
  if (cd "$STYLELINT_DIR" && ./node_modules/.bin/stylelint --config "$LINTDIR/.stylelintrc.json" "$LINTDIR"/*.css); then
    ok lint-css
  else
    bad lint-css "goldens fail stylelint-config-standard"
  fi
  printf '{"extends":["stylelint-config-standard-scss"]}' >"$LINTDIR/.stylelintrc.json"
  if (cd "$STYLELINT_DIR" && ./node_modules/.bin/stylelint --config "$LINTDIR/.stylelintrc.json" "$LINTDIR"/*.scss); then
    ok lint-scss
  else
    bad lint-scss "goldens fail stylelint-config-standard-scss"
  fi
else
  printf 'SKIP lint (set STYLELINT_DIR to a dir with stylelint + standard configs)\n'
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
