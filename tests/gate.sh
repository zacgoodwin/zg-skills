#!/usr/bin/env bash
# Gate test for the stack-ship skill package. Deterministic, offline, <2s.
#   bash tests/gate.sh
# Verifies: script syntax, SKILL.md frontmatter, and the fail-closed jq gate
# published in SKILL.md — extracted from SKILL.md itself so the tested program
# is byte-for-byte the shipped one (no drift between doc and test).
set -u
cd "$(dirname "$0")/.."
fail=0
ok()   { printf 'OK    %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }

for f in check-pipeline.sh setup tests/gate.sh; do
  bash -n "$f" && ok "bash -n $f" || bad "syntax error in $f"
done

head -1 SKILL.md | grep -qx -- '---' && grep -q '^name: stack-ship$' SKILL.md \
  && ok "SKILL.md frontmatter" || bad "SKILL.md frontmatter (--- + name: stack-ship)"

# Extract the jq program from SKILL.md's second bash fence: everything between
# "jq -e '" and the closing "' >/dev/null".
prog=$(awk '/^```bash/{n++} /^```$/{inb=0} n==2 && inb {print} n==2 && /^```bash/{inb=1}' SKILL.md \
  | sed -n "/jq -e '/,\$p" | sed "1s/.*jq -e '//" | sed "s/' >\\/dev\\/null.*//")
if [ -z "$prog" ]; then
  bad "could not extract jq gate from SKILL.md"
else
  ok "jq gate extracted from SKILL.md"
  expect() { # pass|fail json label
    if printf '%s' "$2" | jq -e "$prog" >/dev/null 2>&1; then got=pass; else got=fail; fi
    [ "$got" = "$1" ] && ok "gate $1: $3" || bad "gate expected $1 got $got: $3"
  }
  expect pass 'null'                                       "null (branch has no jobs)"
  expect pass '[]'                                         "empty array"
  expect pass '[{"status":"done","verdict":"P"}]'          "all pass"
  expect pass '[{"status":"queued","verdict":null},{"status":"running","verdict":null},{"status":"canceled","verdict":null}]' "in-flight jobs excluded"
  expect fail '[{"status":"done","verdict":"F"}]'          "F verdict"
  expect fail '[{"status":"done","verdict":"P"},{"status":"done","verdict":"F"}]' "one F among passes"
  expect fail '[{"status":"failed","verdict":null}]'       "crashed review job"
  expect fail '[{"status":"completed","verdict":"F"}]'     "unknown status (schema drift)"
  expect fail '[{"status":"queued","verdict":"P"}]'        "verdict on non-done job (schema drift)"
  expect fail '[{"status":"done","verdict":"X"}]'          "verdict outside P/F (schema drift)"
  expect fail '{}'                                         "non-array response"
fi

exit $fail
