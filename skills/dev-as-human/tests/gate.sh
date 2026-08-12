#!/usr/bin/env bash
# Gate test for the dev-as-human skill package. Deterministic, offline, <2s.
#   bash tests/gate.sh
# Runs the switch published in SKILL.md — extracted from SKILL.md itself, so the
# tested program is byte-for-byte the shipped one — against a throwaway repo and
# a stateful stub `gh`, then asserts the exact name, email and account. That
# triple is the whole risk surface: a typo misattributes commits on GitHub
# without failing anything at runtime. The stub tracks which account a switch
# actually set, so the two ways a switch can quietly not happen (gh errors, gh
# reports a different active account) are tested as failures, not as output.
set -u
cd "$(dirname "$0")/.."
fail=0
ok()  { printf 'OK    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

SKILL=dev-as-human
NAME="Zac Goodwin"
EMAIL="zac.goodwin@gmail.com"
ACCOUNT="zacgoodwin"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# The repo checks out with CRLF on Windows (core.autocrlf=true); a stray \r
# would ride into the git config values as a trailing character.
sed 's/\r$//' SKILL.md >"$tmp/skill.md"

head -1 "$tmp/skill.md" | grep -qx -- '---' \
  && grep -q "^name: $SKILL\$" "$tmp/skill.md" \
  && grep -q '^disable-model-invocation: true$' "$tmp/skill.md" \
  && ok "SKILL.md frontmatter" \
  || bad "SKILL.md frontmatter (--- + name: $SKILL + disable-model-invocation: true)"

block=$(awk '/^```bash/{inb=1;next} /^```/{inb=0} inb' "$tmp/skill.md")
if [ -z "$block" ]; then
  bad "could not extract the bash block from SKILL.md"
  exit $fail
fi
ok "switch block extracted from SKILL.md"
printf '%s\n' "$block" | bash -n && ok "bash -n switch block" || bad "syntax error in switch block"

# Stub gh. Holds the active account in $GH_STATE so `auth status` reports what
# `auth switch` actually did, rather than whatever the test wants to see.
#   GH_FAIL=1  switch errors out
#   GH_NOOP=1  switch exits 0 without changing the active account
mkdir -p "$tmp/bin"
cat >"$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
case "${1:-} ${2:-}" in
  "auth switch")
    if [ "${GH_FAIL:-0}" = 1 ]; then
      echo "gh: could not switch account" >&2
      exit 1
    fi
    [ "${GH_NOOP:-0}" = 1 ] || printf '%s\n' "$4" >"$GH_STATE"
    ;;
  "auth status")
    printf '  Logged in to github.com account %s (keyring)\n  - Active account: true\n' \
      "$(cat "$GH_STATE")"
    ;;
esac
exit 0
STUB
chmod +x "$tmp/bin/gh"

run() { # name gh_fail gh_noop [seed] -> $rc, $out, $log, $repo
  repo="$tmp/$1"; log="$tmp/$1.ghlog"; out="$tmp/$1.out"
  mkdir -p "$repo"
  git init -q "$repo"
  : >"$log"
  # The bot account is active going in — the state this skill exists to undo.
  echo "tordek-ai" >"$tmp/$1.state"
  if [ "${4:-}" = seed ]; then
    git -C "$repo" config --local user.name "Tordek Holderhek"
    git -C "$repo" config --local user.email "301414961+tordek-ai@users.noreply.github.com"
  fi
  ( cd "$repo" \
    && PATH="$tmp/bin:$PATH" GH_LOG="$log" GH_STATE="$tmp/$1.state" \
       GH_FAIL="$2" GH_NOOP="$3" bash -c "$block" ) >"$out" 2>&1
  rc=$?
}

cfg()    { git -C "$repo" config --local --get "$1" 2>/dev/null; }
is()     { [ "$2" = "$3" ] && ok "$1" || bad "$1 (expected '$3', got '$2')"; }
zero()   { [ "$rc" = 0 ] && ok "$1" || bad "$1 (exit $rc)"; }
nonzero(){ [ "$rc" != 0 ] && ok "$1" || bad "$1 (exit 0, failure not surfaced)"; }
has()    { grep -qF "$2" "$1" && ok "$3" || bad "$3 (not found: $2)"; }
hasnt()  { grep -qF "$2" "$1" && bad "$3 (found: $2)" || ok "$3"; }

run happy 0 0 seed
zero "switch exits 0"
is  "user.name overwritten"     "$(cfg user.name)"  "$NAME"
is  "user.email overwritten"    "$(cfg user.email)" "$EMAIL"
has "$log" "auth switch -u $ACCOUNT" "gh auth switch -u $ACCOUNT called"
has "$out" "git identity: $NAME <$EMAIL>" "identity echoed back"
has "$out" "account $ACCOUNT " "active account read back as $ACCOUNT"

# gh errors: set -e must stop before any git config, so the repo stays visibly
# on the bot identity rather than half-switched, and the block reports it.
run guard 1 0 seed
nonzero "gh failure exits non-zero"
is    "user.name untouched on gh failure"  "$(cfg user.name)"  "Tordek Holderhek"
hasnt "$out" "git identity:" "no identity claimed on gh failure"

# gh exits 0 but the account didn't change: the closing grep is what catches it.
run silent 0 1 seed
nonzero "silent no-op switch exits non-zero"
hasnt "$out" "account $ACCOUNT " "no false confirmation on a no-op switch"

exit $fail
