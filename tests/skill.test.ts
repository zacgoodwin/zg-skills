// The SKILL.md is this product's executed surface; these tests pin its
// load-bearing lines and gate its GitHub-CLI invocations against an explicit
// allowlist (scanner ported from zstack's tests/board.test.ts): a NEW direct
// call fails until it is consciously sanctioned here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasExitMarker } from "../evals/lib/recall.ts";
import { STAGE_RESULTS } from "../lib/verdict.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const skill = readFileSync(join(REPO_ROOT, "SKILL.md"), "utf8");

// Every `gh <anything>` invocation that may appear in SKILL.md code contexts
// (fenced blocks and inline backtick spans), whitespace-normalized.
const GH_ALLOWLIST = [
  // Step 1 PR metadata fetch: read-only
  `gh pr view $PR_ARG --json number,title,url,body,headRefOid,baseRefOid,baseRefName,labels,closingIssuesReferences > "$TMP/pr.json"`,
  // Step 1 linked-issue spec fetch: read-only
  `gh issue view "$SPEC_ISSUE" --json body,labels > "$TMP/issue.json"`,
  // Step 4 posting: the skill's ONE mutation, fenced behind an explicit user ask
  `gh pr comment "$PR_NUM" --body-file "$TMP/report.md"`,
];

// Scanner (ported): backslash-continued lines are joined FIRST, then every
// `gh <args>` invocation is extracted from code contexts and normalized.
function ghInvocations(content: string): string[] {
  const joined = content.replace(/\\\r?\n/g, " ");
  const contexts: string[] = [];
  const fenced = /```[^\n]*\n([\s\S]*?)```/g;
  let rest = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(joined))) {
    rest += joined.slice(last, m.index) + "\n";
    contexts.push(m[1]);
    last = m.index + m[0].length;
  }
  rest += joined.slice(last);
  for (const im of rest.matchAll(/`([^`\n]+)`/g)) contexts.push(im[1]);
  const out: string[] = [];
  for (const ctx of contexts) {
    for (const line of ctx.split(/\r?\n/)) {
      for (const g of (" " + line).matchAll(/[\s;|&$(]gh\s+\S[^`]*/g)) {
        const inv = g[0].slice(1).replace(/\s+/g, " ").trim();
        if (!inv.startsWith("gh *")) out.push(inv);
      }
    }
  }
  return out;
}

describe("SKILL.md gh gate", () => {
  test("every gh invocation in code contexts is allowlisted", () => {
    const allowed = new Set(GH_ALLOWLIST);
    const offenders = ghInvocations(skill).filter((inv) => !allowed.has(inv));
    expect(offenders).toEqual([]);
  });

  test("the scan is not vacuous: the three sanctioned calls are actually present", () => {
    const found = ghInvocations(skill);
    for (const inv of GH_ALLOWLIST) expect(found).toContain(inv);
  });

  test("scanner self-test: continuation cannot hide the verb", () => {
    const md = "```bash\ngh \\\n  pr merge 7 --squash\n```\n";
    expect(ghInvocations(md)).toEqual(["gh pr merge 7 --squash"]);
  });
});

describe("SKILL.md pins", () => {
  test("the reviewer spawn is synchronous", () => {
    expect(skill).toContain("run_in_background: false");
  });

  test("every deterministic step routes through lib/review.ts", () => {
    for (const verb of ["prepare", "collect", "cleanup"]) {
      expect(skill).toContain(`lib/review.ts" ${verb}`);
    }
  });

  test("posting to the PR is explicitly opt-in", () => {
    expect(skill).toContain("only when the user explicitly asks");
  });
});

describe("bin shim", () => {
  test("bin/adversarial-review is a pure shim with no GitHub-CLI call of its own", () => {
    const shim = readFileSync(join(REPO_ROOT, "bin", "adversarial-review"), "utf8");
    expect(shim).toContain("lib/review.ts");
    expect(/(^|[\s;|&$("'`])gh[\s'"]/m.test(shim)).toBe(false);
  });
});

// The vendored eval scorer's marker gate must accept exactly this product's
// reviewer result union -- run.sh feeds it the verdict file's `result` (or
// NONE when the file is missing/invalid), so a drift between the two would
// silently fail (or pass) the eval's second gate.
describe("eval scorer alignment", () => {
  test("every reviewer result is an accepted exit marker; NONE is not", () => {
    for (const r of STAGE_RESULTS.reviewer) expect(hasExitMarker(r)).toBe(true);
    expect(hasExitMarker("NONE")).toBe(false);
    expect(hasExitMarker("")).toBe(false);
  });
});
