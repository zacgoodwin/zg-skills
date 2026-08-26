---
name: zg-verify-claims
description: |
  Audits a repo with subagents that may only propose findings as structured
  evidence, never prose. A script re-derives every claim off the filesystem
  before a human reads it: file exists, line says what was quoted, count is
  what was measured, reference resolves. Anything that does not reproduce is
  discarded and listed as discarded, so you see what the agent got wrong
  instead of fact-checking it yourself. Findings are checked against the repo,
  not against each other.
  Use when asked to "zg-verify-claims", "audit this repo", "audit the docs",
  "check these findings", "verify what the agent found", or when an agent
  report needs to be trustworthy without being read line by line.
---

# /zg-verify-claims — Audit with a verification gate

An agent that reads your code and reports what is wrong with it produces
claims. Some are true. Some cite a line it never opened, a count it never
measured, a file that does not exist. Read as prose the two are
indistinguishable, which is the whole reason reviewing agent output by hand
costs what it does.

This makes the report a build artifact. An agent may only **propose** a
finding, and a proposal that does not reproduce against the filesystem is
discarded before it reaches you.

The rule the whole thing exists to enforce: **no finding reaches the report
unless `verify-claims` reproduced its evidence.** A claim does not get argued
through on the strength of its conclusion. If it cannot be shown, it is
discarded and named.

> Scope note: this checks findings **against the repo**. For contradictions
> *between documents* read as one, with no filesystem access at all, use
> `/zg-doc-integrity` instead. They are opposites on purpose.

---

## Phase 0 — deterministic checks first

If the repo already has checkers that measure rather than judge (a linter, a
link checker, a test suite, a `--json` reporting tool), run them and read the
output before dispatching anything.

```
RUN=.audit/$(date +%Y%m%d-%H%M%S)
mkdir -p "$RUN"
# e.g. npm run lint -- --format json > "$RUN/mechanical.json"
```

Those findings are already measured. They enter the report as-is, and **you do
not spend an agent re-deriving them.** Tell the fan-out what they contain so it
does not re-report them.

If the repo has no such checkers, say so and move on. Do not invent one.

## Phase 1 — fan out

Split the scope into 3-5 slices, by directory or by claim family. Dispatch one
subagent per slice **in parallel, in a single message**.

Each agent hunts what a script cannot: guidance that contradicts other
guidance, instructions that cannot be followed as written, a doc describing a
workflow the repo no longer has, a claim about the repo that is simply false.

Give every agent this contract verbatim:

> Write `<RUN>/claims-<slice>.json` as your FIRST action, containing
> `{"slice":"<slice>","claims":[]}`. Append each claim as you find it. Never
> hold findings in context to write at the end. If you are interrupted,
> whatever you already wrote must survive.
>
> Emit **claims, not prose.** Every claim is an object:
>
> ```json
> {
>   "id": "slice-01",
>   "finding": "one sentence a human can act on",
>   "file": "src/thing.ts",
>   "line": 42,
>   "severity": "P1|P2|P3",
>   "evidence": [ ... ]
> }
> ```
>
> `evidence` is a non-empty array. Each item is one of:
>
> - `{"type":"file_exists","path":"src/x.ts"}` — add `"absent":true` to
>   assert something is missing.
> - `{"type":"line_content","file":"src/x.ts","line":42,"contains":"text"}`
>   — or `"matches":"regex"`. Omit `line` to assert only that the text is
>   somewhere in the file. Add `"normalize":true` to check a prose quote that
>   spans line breaks. **Cite a line only if you read that line.**
> - `{"type":"count","kind":"files|dirs|lines|matches","path":"src",
>   "pattern":"optional regex","expected":9,"op":"eq|gte|lte"}`
> - `{"type":"cross_reference","from":"README.md","to":"docs/x.md",
>   "anchor":"optional-heading"}`
>
> Rules, all of them hard:
> 1. Never write a count you did not measure. Express it as a `count` claim and
>    let the verifier measure it.
> 2. Never cite a line number you did not read. A drifted line number fails
>    verification and sinks the whole claim.
> 3. A claim whose evidence you cannot express in these four types is not
>    admissible. Drop it rather than dressing it up.
> 4. One weak evidence item sinks the claim. Attach only what reproduces.
> 5. Patterns are JavaScript regular expressions. `(?i)` is not one; use
>    `[Aa]` or the `matches` form.
> 6. Do not report anything the Phase 0 output already holds.
>
> Return only the path to your claims file.

Quality over volume. Three to eight real claims per slice is a good result.
Zero is an acceptable and honest result for a clean slice, and should be
reported as such rather than padded.

## Phase 2 — verify

```
jq -s '{claims: (map(.claims) | add)}' "$RUN"/claims-*.json > "$RUN/claims.json"
verify-claims "$RUN/claims.json" --json > "$RUN/verdict.json"
```

`verify-claims` exits 1 when anything was discarded. **That is the expected
outcome, not a failed run.** It is the filter doing its job.

Do not retry it. Do not loosen a claim to make it pass. Never edit a claim's
evidence to fit what was measured. The measurement is the truth.

## Phase 3 — report

Write `<RUN>/report.md`, in this order:

1. **Verified findings** — Phase 0 output plus `verdict.json` `verified[]`,
   each with the evidence line that proved it, sorted by severity. Nothing
   else may appear here.
2. **Discarded** — every entry in `verdict.json` `discarded[]`, with the claim
   as proposed and the `why` from the verifier. This section is mandatory and
   is never summarised away. It is how the reader sees what the agents got
   wrong.
3. **Coverage** — scope scanned, claims proposed, verified, discarded.

Then tell the user the verified count, the discard count, and the report path.

**Do not fix anything.** An audit reports. Fixing is a separate, approved step.

---

## What this does not do

Verification catches fabrication. It does not catch a bad premise. A claim can
reproduce perfectly and still be wrong, because the agent compared the wrong
two things. When a verified finding looks wrong to you, it may well be, and
that judgment is still yours.

When you close a verified finding as not-a-defect, say so in the report and say
why, so the next run does not raise it again.
