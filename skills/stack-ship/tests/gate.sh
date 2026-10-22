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

# Extract and exercise the range setup against the remote default branch.
range_setup=$(sed -n '/^trunk=$(git symbolic-ref/,/^range=/p' SKILL.md)
range_case() { # stale|missing
  local d expected got base
  d=$(mktemp -d)
  (
    cd "$d" || exit 1
    git init -q
    git config user.name test
    git config user.email test@example.com
    git commit -q --allow-empty -m initial
    base=$(git rev-parse HEAD)
    git branch -M main
    git commit -q --allow-empty -m upstream
    expected=$(git rev-parse HEAD)
    git update-ref refs/remotes/origin/main "$expected"
    git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
    git switch -q -c feature
    git commit -q --allow-empty -m feature
    head=$(git rev-parse HEAD)
    if [ "$1" = stale ]; then git branch -f main "$base" >/dev/null; else git branch -D main >/dev/null; fi
    eval "$range_setup"
    [ "$range" = "$expected..$head" ]
  )
  got=$?
  rm -rf "$d"
  [ "$got" -eq 0 ] && ok "range uses origin default with $1 local default branch" \
    || bad "range ignored origin default with $1 local default branch"
}
if [ -z "$range_setup" ]; then
  bad "could not extract range setup from SKILL.md"
else
  range_case stale
  range_case missing
fi

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
  expect fail 'null'                                       "null ledger response (no evidence)"
  expect fail '[]'                                         "empty array (no evidence)"
  expect pass '[{"status":"done","verdict":"P"}]'          "all pass"
  expect pass '[{"status":"done","verdict":"P"},{"status":"queued","verdict":null},{"status":"running","verdict":null},{"status":"canceled","verdict":null}]' "in-flight jobs excluded (with a real P)"
  expect fail '[{"status":"queued","verdict":null},{"status":"running","verdict":null},{"status":"canceled","verdict":null}]' "only in-flight jobs, no completed P evidence"
  expect fail '[{"status":"done","verdict":"F"}]'          "F verdict"
  expect fail '[{"status":"done","verdict":"P"},{"status":"done","verdict":"F"}]' "one F among passes"
  expect fail '[{"status":"failed","verdict":null}]'       "crashed review job"
  # Supersession fixtures: the branch as it stands is aaaaaaa..bbbbbbb.
  export GATE_RANGE=aaaaaaa..bbbbbbb
  expect pass '[{"id":3,"git_ref":"aaaaaaa..bbbbbbb","status":"done","verdict":"P"},{"id":1,"git_ref":"c1","status":"failed","verdict":null}]' "crashed job superseded by a later review of the whole branch"
  expect pass '[{"id":2,"git_ref":"c1","status":"done","verdict":"P"},{"id":1,"git_ref":"c1","status":"failed","verdict":null}]' "crashed job superseded by a later review of the same commit"
  expect pass '[{"id":3,"git_ref":"aaaaaaa..bbbbbbb","status":"done","verdict":"P"},{"id":2,"git_ref":"aaaaaaa..bbbbbbb","status":"failed","verdict":null}]' "crashed branch review superseded by its own later retry"
  expect fail '[{"id":3,"git_ref":"bbbbbbb..ccccccc","status":"done","verdict":"P"},{"id":1,"git_ref":"c1","status":"failed","verdict":null}]' "a narrower range (--since) does not cover the crashed commit"
  expect fail '[{"id":3,"git_ref":"aaaaaaa..ddddddd","status":"done","verdict":"P"},{"id":1,"git_ref":"c1","status":"failed","verdict":null}]' "a branch review of an older HEAD does not supersede"
  expect fail '[{"id":3,"git_ref":"ddddddd..eeeeeee","status":"done","verdict":"P"},{"id":2,"git_ref":"aaaaaaa..bbbbbbb","status":"failed","verdict":null}]' "a crashed branch review is not superseded by some other range"
  expect fail '[{"id":1,"git_ref":"aaaaaaa..bbbbbbb","status":"done","verdict":"P"},{"id":2,"git_ref":"c1","status":"failed","verdict":null}]' "crashed job newer than every done review"
  expect fail '[{"id":3,"git_ref":"c2","status":"done","verdict":"P"},{"id":1,"git_ref":"c1","status":"failed","verdict":null}]' "a later review of a DIFFERENT commit does not supersede"
  expect fail '[{"id":1,"git_ref":"c1","status":"done","verdict":"P"},{"id":2,"git_ref":"aaaaaaa..bbbbbbb","status":"failed","verdict":null}]' "the branch review itself crashed"
  expect fail '[{"git_ref":"aaaaaaa..bbbbbbb","status":"done","verdict":"P"},{"git_ref":"c1","status":"failed","verdict":null}]' "no ids: cannot order, so the crash still blocks"
  expect fail '[{"id":2,"git_ref":"aaaaaaa..bbbbbbb","status":"done","verdict":"P"},{"git_ref":"c1","status":"failed","verdict":null}]' "crash missing its id is not outranked (number > null)"
  expect fail '[{"id":2,"git_ref":"aaaaaaa..bbbbbbb","status":"done","verdict":"P"},{"id":"1","git_ref":"c1","status":"failed","verdict":null}]' "string id is not ordered against a number"
  expect fail '[{"id":"3","git_ref":"aaaaaaa..bbbbbbb","status":"done","verdict":"P"},{"id":1,"git_ref":"c1","status":"failed","verdict":null}]' "a done job's string id does not outrank (jq orders strings above numbers)"
  expect fail '[{"id":3,"git_ref":"aaaaaaa..bbbbbbb","status":"done","verdict":"P"},{"id":1,"status":"failed","verdict":null}]' "a crash missing its git_ref is not superseded, even by the whole branch"
  expect fail '[{"id":2,"status":"done","verdict":"P"},{"id":1,"status":"failed","verdict":null}]' "both git_refs missing do not match (null == null)"
  expect fail '[{"id":2,"git_ref":["aaaaaaa..bbbbbbb"],"status":"done","verdict":"P"},{"id":1,"git_ref":"c1","status":"failed","verdict":null}]' "non-string git_ref is not a branch range"
  # A malformed GATE_RANGE (merge-base failed, or unset) turns range supersession off,
  # even when a done job's git_ref is that same malformed string.
  export GATE_RANGE=..bbbbbbb
  expect fail '[{"id":3,"git_ref":"..bbbbbbb","status":"done","verdict":"P"},{"id":1,"git_ref":"c1","status":"failed","verdict":null}]' "malformed GATE_RANGE supersedes nothing"
  unset GATE_RANGE
  expect fail '[{"id":3,"git_ref":"aaaaaaa..bbbbbbb","status":"done","verdict":"P"},{"id":1,"git_ref":"c1","status":"failed","verdict":null}]' "unset GATE_RANGE supersedes nothing"
  expect fail '[{"status":"completed","verdict":"F"}]'     "unknown status (schema drift)"
  expect fail '[{"status":"queued","verdict":"P"}]'        "verdict on non-done job (schema drift)"
  expect fail '[{"status":"done","verdict":"X"}]'          "verdict outside P/F (schema drift)"
  expect fail '{}'                                         "non-array response"
fi

# The version-bump line published in SKILL.md, tested byte-for-byte like the
# jq gate: extract the printf that rewrites VERSION and run it on fixtures.
bump=$(grep -o "printf .*> VERSION" SKILL.md | head -1)
if [ -z "$bump" ]; then
  bad "could not extract version-bump line from SKILL.md"
else
  ok "version-bump line extracted from SKILL.md"
  bump_case() { # input expected
    local d got; d=$(mktemp -d)
    ( cd "$d" && v="$1" && eval "$bump" )
    got=$(cat "$d/VERSION" 2>/dev/null)
    rm -rf "$d"
    [ "$got" = "$2" ] && ok "bump $1 -> $2" || bad "bump $1 expected $2 got '$got'"
  }
  bump_case 1.2.3 1.2.4
  bump_case 0.9.9 0.9.10
fi

exit $fail
