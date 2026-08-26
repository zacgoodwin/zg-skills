# zg-verify-claims

Audit a repo with agents whose findings are machine-checked before you read
them.

An agent that reads your code and reports what is wrong with it produces
claims. Some are true. Some cite a line it never opened, a count it never
measured, a file that does not exist. Read as prose the two are
indistinguishable, which is why reviewing agent output by hand costs what it
does.

`verify-claims` takes findings as structured evidence, re-derives every piece
off the filesystem, and discards anything that does not reproduce. What
survives goes into the report without being fact-checked. What does not is
named, so you can see what the agent got wrong.

## Install

```bash
npx skills add zacgoodwin/zg-skills --skill zg-verify-claims
```

Then invoke `/zg-verify-claims` in Claude Code.

The verifier is plain Node with zero dependencies, so you can also use it on
its own:

```bash
node ~/.claude/skills/zg-verify-claims/bin/verify-claims.mjs claims.json
```

Put it on your PATH if you want it everywhere:

```bash
ln -s ~/.claude/skills/zg-verify-claims/bin/verify-claims.mjs ~/.local/bin/verify-claims
```

Requires Node 18 or newer. Git is used when present (tracked files are the
better inventory, since an untracked file is not in a clone) and falls back to
a filesystem walk when the target is not a checkout.

## Use

```bash
verify-claims <claims.json> [--json] [--root <dir>]
verify-claims --self-test
```

`--root` points at the repo being audited; it defaults to the enclosing git
checkout, or the working directory. Exit code is 1 if any claim was discarded,
2 on bad usage.

A claims file is a list of findings, each carrying non-empty evidence:

```json
{"claims": [
  {
    "id": "docs-01",
    "finding": "SETUP step 8 installs a hook that skips the reference check",
    "file": "docs/SETUP.md",
    "line": 152,
    "severity": "P1",
    "evidence": [
      {"type": "line_content", "file": "docs/SETUP.md", "line": 152, "contains": "node tools/gate.mjs"},
      {"type": "file_exists", "path": ".githooks/pre-commit"},
      {"type": "count", "kind": "matches", "path": ".githooks/pre-commit", "pattern": "gate\\.mjs", "expected": 0}
    ]
  }
]}
```

A claim survives only if **every** piece of its evidence reproduces. One weak
item sinks it.

## Evidence types

| Type | Asserts | Key fields |
|---|---|---|
| `file_exists` | a path is there, or deliberately is not | `path`, `absent` |
| `line_content` | a file says what was quoted | `file`, `contains` or `matches`, optional `line`, `normalize` |
| `count` | a measured number | `kind` (`files`/`dirs`/`lines`/`matches`), `path`, `pattern`, `expected`, `op` |
| `cross_reference` | one file points at another, and it resolves | `from`, `to`, optional `anchor` |

Three details that matter in practice:

**Omit `line` when you are not certain of it.** A cited line number that
drifted is still a wrong citation, and it fails. The failure names the line the
content is actually on, which is usually the more useful output.

**Use `normalize` for prose quotes.** Text reflows, so a quoted sentence spans
line breaks and collapses runs of spaces. `normalize` flattens the file and
checks the quote against that, which is the only fair test of whether the agent
read it.

**Counting is declarative, never a shell command.** `count` takes a kind and a
pattern, not something to execute. Agent-authored JSON should not be able to
run anything, and here it cannot.

## Output

```
verify-claims: 8/9 claim(s) verified, 1 discarded

VERIFIED
  PASS docs-01  docs/SETUP.md:152  SETUP step 8 installs a hook that skips the reference check
       line_content: docs/SETUP.md:152 matches
       file_exists: .githooks/pre-commit exists; claim wanted it present
       count: measured 0 (/gate\.mjs/g across 1 file(s)); claim said eq 0

DISCARDED (failed verification; must not appear in the report)
  FAIL docs-04  docs/archive/OLD.md  the archive carries no retirement marker
       why: evidence threw: Invalid regular expression: /(?i)archiv/: Invalid group
```

The discard list is the point. A run where nothing is discarded tells you
little; a run that names two bad citations tells you exactly what would have
reached your report unchecked.

## How it differs from zg-doc-integrity

They are opposites, deliberately.

| | checks | filesystem |
|---|---|---|
| `zg-doc-integrity` | documents against **each other** | none, by design |
| `zg-verify-claims` | claims against **the repo** | the whole point |

`zg-doc-integrity` records a reference to a document you did not pass as
unverifiable and never chases it. This chases everything. Use the first when a
long document has drifted against itself; use this when you want an agent's
findings about a codebase to be trustworthy without reading each one.

They compose: run a doc-integrity pass for internal contradictions, then an
audit for claims about the code.

## What it does not do

Verification catches fabrication. It does not catch a bad premise.

A claim can reproduce perfectly and still be wrong, because the agent compared
the wrong two things. In the run this was extracted from, a P1 finding verified
on all eleven of its evidence items and was still closed as not-a-defect: it
had compared a group of things installed as a unit against a rule that was
about the individual things. Every measurement was right. The comparison was
not.

This raises the floor. It does nothing to the ceiling, and the judgment stays
yours.

## Tests

```bash
bash tests/gate.sh
```

Runs the verifier's self-test: 30-odd assertions over a temp fixture built from
scratch, covering every evidence type, CRLF files, drifted line numbers,
malformed agent regexes, unknown evidence kinds, and the no-evidence case. It
depends on no repo and no network.
