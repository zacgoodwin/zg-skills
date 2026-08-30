---
name: zg-doc-integrity
description: |
  Finds internal contradictions and language drift across one or many documents
  reviewed as a single document: instructions that conflict, one term used for
  two things, two terms used for one thing, numbers and versions that disagree,
  and structural references that dangle. Every instance is cited by line, every
  finding offers resolution options with their costs, and no option is
  recommended -- the judgment stays with the human. Nothing is edited until a
  person ticks a box; any comment they leave sends the round back for another
  pass instead. Reviewers see ONLY the documents passed in -- no repo, no web,
  no outside knowledge. Outside CLIs (codex, agy/Antigravity) can staff both a
  discovery pass and an adversarial refutation pass.
  Use when asked to "zg-doc-integrity", "check these docs for contradictions",
  "find drift across these documents", "review my docs for internal
  consistency", or when a long AI-written document needs checking against
  itself.
---

# /zg-doc-integrity — Internal Document Integrity Review

Long documents drift. Edit by edit, one section starts saying something another
section contradicts, a term picks up a second meaning, a timeout that was 30
seconds in the quickstart is 60 in the reference. This skill reads a set of
documents **as one document** and finds those collisions.

Two rules define it:

**The review is strictly internal.** Reviewers get a throwaway directory holding
copies of the documents and nothing else. No repo, no git, no web, none of your
context. A reference to a document you did not pass is recorded as unverifiable,
never chased. If the documents disagree with the world, that is not a finding.
If they disagree with each other, it is.

**Nothing is edited until a human decides.** Every finding presents its sides
and its ways out with the cost of each, and names no winner. The plan is a file
you edit. Any comment you leave sends the round back for another pass rather
than through to apply.

Everything decidable is decided in code (`lib/run.ts`): what to shard, what to
compare, which quote resolves where, what severity and confidence a finding
gets, which findings earn a refuter, what the edited plan means, and whether the
edits that landed were the ones approved. Your latent work is exactly two
things: spawn the seats the manifests describe, and relay what the verbs print.

**Prerequisites:** `bun` on PATH. Run from inside the repo holding the documents.

```bash
PACK=".claude/skills/zg-doc-integrity"
[ -d "$PACK" ] || PACK="$HOME/.claude/skills/zg-doc-integrity"
```

## Step 0 — First run: choose the outside CLIs (once, ever)

A one-time, per-user choice, saved under `~/.claude/zg-doc-integrity/`. Once
saved, later reviews reuse it silently and this step is a no-op.

```bash
bun "$PACK/lib/providers.ts" preference
```

- `{"exists": true, ...}` — skip to Step 1. A `"source": "sibling"` means the
  choice came from an existing `z-adversarial-review` preference, so the user is
  not asked the same question twice; treat it as answered.
- `{"exists": false, ...}` — first run. If the user's own phrasing already names
  a lineup ("with codex", "use Antigravity"), use it. Otherwise ask with
  AskUserQuestion: "Which outside CLIs should help review these documents?" with
  four options — "Claude only (default)" (`[]`), "codex only" (`["codex"]`),
  "agy only" (`["agy"]`), "codex + agy" (`["codex","agy"]`).

Validate the choice (skip when the answer is `[]`), then save it:

```bash
bun "$PACK/lib/providers.ts" setup --repo . --providers codex,agy
bun "$PACK/lib/providers.ts" preference --set '["codex","agy"]'
```

Relay the setup table as-is. A MISSING row names its own fix — tell the user,
but save the choice anyway so they are asked only once; `prepare`'s own
preflight enforces it on the run that actually needs that seat.

## Step 1 — Prepare (deterministic)

`$DOCS` is what the user named: paths, globs, or both, in the order they gave
them. Order matters — it assigns D1, D2, … and orders each finding's options.

```bash
bun "$PACK/lib/run.ts" prepare $DOCS --repo .
```

This loads the documents, tags the regions that must not be read as current
prose (code fences, changelog and history sections, quoted examples,
front matter), copies the documents into a throwaway bundle directory, builds
the four inventories, plans the shards, runs the structure lens, and writes
every brief to disk. It prints a manifest:

- `spawns` — every seat to run. Each carries a `stub` (the prompt you pass), a
  `briefPath` (which the seat reads, not you), and an `outPath`.
- `structureFindings` — already found, with no model involved.
- `inventory` — how many term, numeric and directive clusters the agents will judge.
- `skipped` — every cap that bit. Repeat these to the user; they are the
  difference between "we checked everything" and "we checked what we could".

**Run every spawn.** For a spawn with no `command`, use the Agent tool with its
`stub` as the `prompt`, verbatim, and `run_in_background: false`. The stub is a
~300-byte pointer; the seat reads its own brief off disk. Spawns are
independent, so issue them in one message and they run concurrently. For a spawn
WITH a `command`, run that command verbatim through Bash, foreground: it is a
composed CLI invocation already scoped to the bundle directory.

**Never open a brief, a document, an inventory, or a shard yourself.** Pass the
`stub`, not the brief's contents. A brief holds the material under review, and
you are the one who writes the report at the end — reading it puts the documents
into the one context that is supposed to stay out of them.

## Step 2 — Merge (deterministic)

```bash
bun "$PACK/lib/run.ts" merge --run "$RUN_ROOT"
```

Resolves every quote to its citations, drops the ungrounded ones as
unverifiable, merges findings several seats agree on, and dispatches what comes
next. Two things in the output need action:

- `reduceSpawn` — non-null on the first call. This is the pass that compares the
  claim ledgers across every shard, which is the only way a contradiction
  sharing no vocabulary gets caught. Run it, then **call `merge` again**.
- `refuteSpawns` — one per refuter per finding, capped and ranked so adversaries
  go where the stakes are highest and the evidence thinnest. Run them all, same
  rules as Step 1: pass the `stub`, or run the `command` when there is one.

`seatsSilent` names any seat that wrote no file. That is not the same as finding
nothing, and the plan says so.

## Step 3 — Collect and hand over the plan

```bash
bun "$PACK/lib/run.ts" collect --run "$RUN_ROOT"
```

Counts the refutation quorum off the verdict files on disk — never off an
agent's account of them — scores confidence, and writes `plan.md` and
`plan.json`.

Tell the user the counts and the path to `plan.md`, and that they should tick
one box per finding. Do not summarize the findings yourself: the plan is the
deliverable, it is written for them, and paraphrasing it into chat invites them
to decide from your summary rather than from the citations.

## Step 4 — Continue (the gate)

After the user has edited the plan:

```bash
bun "$PACK/lib/run.ts" continue --run "$RUN_ROOT"
```

The plan's own contents decide what happens. `action` is one of:

- `NOT-REVIEWED` — untouched. Nothing was edited. Point them at the file.
- `BLOCKED` — ambiguous or incomplete. `reasons` names every problem by finding
  id. Relay them verbatim; never guess at a disposition.
- `REGENERATE` — a comment was left. `regenSpawns` holds one targeted brief per
  commented finding. Run them, then go back to Step 2's `merge`. `reopened`
  lists any carried-forward answer that was dropped because its options changed.
- `APPLY` — complete. `applySpawns` holds one brief per FILE, so two agents
  never edit the same document. Run them with the Agent tool, then Step 5.

## Step 5 — Verify

```bash
bun "$PACK/lib/run.ts" verify --run "$RUN_ROOT"
```

Diffs each edited file against the snapshot taken before the first write, and
checks two things: every approved edit happened, and nothing else changed. An
apply agent that also fixed a typo fails the run — that change was reviewed by
nobody. On failure, `restoreHints` holds the exact copy commands to roll back;
relay them and stop.

On success, say what landed and offer the re-review command (printed as
`nextCommand`). Do not run it unprompted.

## Setup — validate the outside fleet

```bash
bun "$PACK/lib/providers.ts" setup --repo . [--trust] [--probe]
```

`--trust` writes the codex trust entry for this repo (idempotent, prints exactly
what it changed). `--probe` makes one live micro-call per CLI — the only paid
check. Relay the table as-is.

## Honesty limits worth knowing

- **A clean report means "nothing found", not "nothing there."** Recall is
  unmeasured on your documents. The plan states every cap that bit and every
  seat that went silent; repeat those rather than rounding them off.
- **Severity and confidence are computed, not measured.** They come from a fixed
  rubric over facts the agents supply, which makes them consistent and
  fixable — not correct. The constants are tuned against the eval fixtures in
  `evals/`, not against your document set.
- **Findings are self-reported until they are grounded.** What is enforced is
  that every citation resolves to real text, that the refutation quorum is
  counted off disk, and that an apply cannot touch a line the plan did not
  approve. A reviewer can still be wrong; it cannot be QUIETLY wrong in the ways
  this design has already seen.
- **The decisions ledger is per-run.** A "change nothing" suppresses that
  finding for the rest of this review, not for the next one.
- **CLI seats execute with their vendor's permission prompts skipped**, scoped
  to the throwaway bundle directory. They read copies of the documents under
  review and nothing else. Stated plainly, not hidden.
- **A CLI seat is always handed its brief, never sent to find it.** The whole
  brief goes in as input — on stdin for codex, and for agy either inlined or, on
  a brief past the OS argv limit, as one stdin message. A seat is never given a
  path and left to decide how much to read, because one that was read 2.8% of
  its material and reported no findings. If a brief exceeds the provider's input
  cap it is split into parts, each a full seat whose silence is reported on its
  own, and the split is named in the plan's skipped list. A brief so large that
  a single cluster will not fit is refused by name rather than truncated.
