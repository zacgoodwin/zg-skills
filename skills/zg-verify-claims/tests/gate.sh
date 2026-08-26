#!/usr/bin/env bash
# Gate test for the zg-verify-claims skill package. Deterministic, offline, <2s.
#   bash tests/gate.sh
#
# Three things are checked, in rising order of what they would cost to get
# wrong:
#
# 1. The verifier's own self-test, which covers every evidence type against a
#    temp fixture built from scratch.
# 2. The exit codes, because callers branch on them. A verifier that discards a
#    claim and still exits 0 is worse than no verifier: it reports success over
#    a finding it just threw away.
# 3. Parity between SKILL.md and the implementation. SKILL.md is the contract
#    handed verbatim to subagents; if it names an evidence type the code does
#    not handle, every claim using it fails verification and the agent has no
#    way to know why.
set -u
cd "$(dirname "$0")/.."
fail=0
ok()  { printf 'OK    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

BIN=bin/verify-claims.mjs
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- 1. the verifier's own suite ---------------------------------------------

if node "$BIN" --self-test > "$TMP/selftest.out" 2>&1; then
  ok "verify-claims --self-test passes"
else
  bad "verify-claims --self-test failed:"
  sed 's/^/      /' "$TMP/selftest.out"
fi

# --- 2. exit codes ------------------------------------------------------------

# A repo to make claims about: this skill package itself.
printf '{"claims":[{"id":"a","finding":"the skill file ships","evidence":[{"type":"file_exists","path":"SKILL.md"}]}]}\n' > "$TMP/pass.json"
node "$BIN" "$TMP/pass.json" --root . > /dev/null 2>&1
[ $? -eq 0 ] && ok "exit 0 when every claim verifies" || bad "expected exit 0 when every claim verifies"

printf '{"claims":[{"id":"b","finding":"invented","evidence":[{"type":"file_exists","path":"does-not-exist.md"}]}]}\n' > "$TMP/fail.json"
node "$BIN" "$TMP/fail.json" --root . > /dev/null 2>&1
[ $? -eq 1 ] && ok "exit 1 when a claim is discarded" || bad "expected exit 1 when a claim is discarded"

# An unevidenced claim is an opinion; it must not pass as one.
printf '{"claims":[{"id":"c","finding":"no evidence","evidence":[]}]}\n' > "$TMP/bare.json"
node "$BIN" "$TMP/bare.json" --root . > /dev/null 2>&1
[ $? -eq 1 ] && ok "exit 1 when a claim carries no evidence" || bad "expected exit 1 for an unevidenced claim"

node "$BIN" "$TMP/nonexistent-file.json" > /dev/null 2>&1
[ $? -eq 2 ] && ok "exit 2 when the claims file is missing" || bad "expected exit 2 for a missing claims file"

printf 'not json at all\n' > "$TMP/bad.json"
node "$BIN" "$TMP/bad.json" > /dev/null 2>&1
[ $? -eq 2 ] && ok "exit 2 when the claims file is not JSON" || bad "expected exit 2 for malformed JSON"

node "$BIN" > /dev/null 2>&1
[ $? -eq 2 ] && ok "exit 2 when no claims file is given" || bad "expected exit 2 with no arguments"

# The discard list is the product; a silent drop defeats the whole design.
node "$BIN" "$TMP/fail.json" --root . 2>&1 | grep -q "DISCARDED" \
  && ok "a discarded claim is named in the output" \
  || bad "a discarded claim must be named, not silently dropped"

# --- 3. SKILL.md and the implementation agree on the evidence types -----------

for t in file_exists line_content count cross_reference; do
  in_doc=$(grep -c "\"type\":\"$t\"" SKILL.md)
  in_code=$(grep -c "case \"$t\":" "$BIN")
  if [ "$in_doc" -ge 1 ] && [ "$in_code" -ge 1 ]; then
    ok "evidence type $t is both documented and implemented"
  else
    bad "evidence type $t: $in_doc mention(s) in SKILL.md, $in_code handler(s) in $BIN"
  fi
done

# Nothing implemented but undocumented: an agent cannot use what it is not told
# about, and a handler nobody knows exists is dead weight.
undocumented=""
for t in $(grep -o 'case "[a-z_]*":' "$BIN" | sed 's/case "//; s/"://' | sort -u); do
  case "$t" in
    files|dirs|lines|matches) continue ;;  # count kinds, documented as a field
  esac
  grep -q "\"type\":\"$t\"" SKILL.md || undocumented="$undocumented $t"
done
[ -z "$undocumented" ] && ok "no evidence type is implemented but undocumented" \
  || bad "implemented but not in SKILL.md:$undocumented"

exit $fail
