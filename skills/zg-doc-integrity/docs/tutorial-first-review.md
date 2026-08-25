# Your first review

Fifteen minutes, using the skill's own eval fixture so you can see it find
things you know are there.

## 1. Point it at the fixture

The fixture is two documents that disagree with each other in seven planted
ways, plus seven things that look like disagreements and are not.

```bash
cd skills/zg-doc-integrity
FIX="$PWD/evals/fixtures/drifted"
bun lib/run.ts prepare guide.md reference.md --repo "$FIX"
```

Read the manifest it prints. Three things are worth noticing before you run
anything:

- `structureFindings` is already non-zero. That is the duplicate `## Errors`
  heading in `reference.md`, found in code with no model involved.
- `inventory` counts the clusters the agents will be asked to judge. These are
  candidates, not findings — most of them will turn out to be nothing.
- `spawns` each have a `briefPath`. Open one. It is a complete, self-contained
  brief; the agent that receives it knows nothing else.

## 2. Run the seats

For each spawn without a `command`, read its brief file and pass the contents as
an Agent prompt with `run_in_background: false`. Issue them together so they run
concurrently. If you configured codex or agy, spawns with a `command` run that
string verbatim through Bash instead.

Do not open the documents yourself. Your context is not blinded, and everything
you read makes your later summary less trustworthy, not more.

## 3. Merge, twice

```bash
RUN=$(ls -d "$FIX"/.doc-integrity/runs/* | tail -1)
bun lib/run.ts merge --run "$RUN"
```

The first call resolves every quote, drops the ungrounded ones, merges what
several seats agreed on, and hands you a `reduceSpawn`. That one reads the claim
ledgers the shard seats wrote and hunts for contradictions across the whole set
— it is the only thing that can catch the fixture's Friday-deploy conflict,
because those two sentences share no vocabulary at all.

Run it, then call `merge` again. Now you get `refuteSpawns`: adversaries whose
job is to kill individual findings. Run those too.

## 4. Collect

```bash
bun lib/run.ts collect --run "$RUN"
open "$RUN/r1/plan.md"
```

Look at one finding. It has both sides quoted with every line they appear on,
two or more options with what each one costs, and no recommendation. The
`Resolution:` line is the only thing the tool reads back.

## 5. Answer it three ways

**Try a comment first.** Under one finding's `**Comment:**`, write "these are
scoped to different environments". Save.

```bash
bun lib/run.ts continue --run "$RUN"
```

`action` is `REGENERATE`. Nothing was edited. You get a targeted brief that
carries your comment to one agent — not a re-run of the whole review.

**Now try leaving it half-answered.** Tick one finding, leave another blank.

```bash
bun lib/run.ts continue --run "$RUN"
```

`BLOCKED`, naming the finding you skipped. The tool never guesses.

**Finally, answer everything.** Tick an option letter or "change nothing" on
each finding, remove your comment, and run `continue` again. Now `action` is
`APPLY` and you get one brief per file.

## 6. Watch verify catch a helpful agent

Run the apply briefs, then before verifying, open one of the edited files and
fix a typo somewhere else. Anything at all.

```bash
bun lib/run.ts verify --run "$RUN"
```

It fails, names the line, and hands you the restore command. That is the point:
the approved edits were reviewed by a human and your typo fix was not, and the
tool cannot tell a good unreviewed change from a bad one.

## 7. Clean up

```bash
rm -rf "$FIX/.doc-integrity"
git -C "$FIX" checkout -- . 2>/dev/null || true
```

## What to do on your own documents

Pass the ones that should agree with each other, most authoritative first:

```bash
/zg-doc-integrity docs/spec.md docs/guide.md README.md
```

Argument order assigns D1, D2, … and orders each finding's options. It does not
make anything authoritative — no option is ever recommended — but it makes the
plan easier to read when you already know which document you trust.
