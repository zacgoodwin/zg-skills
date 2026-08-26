#!/usr/bin/env node
// verify-claims: turn an agent's opinions into findings, or throw them away.
//
// An agent that reads your code and reports what is wrong with it produces
// claims. Some are true. Some cite a line it never opened, a count it never
// measured, a file that does not exist. Read as prose the two are
// indistinguishable, which is why reviewing agent output by hand is so
// expensive.
//
// This takes claims as structured evidence, re-derives every piece off the
// filesystem, and discards anything that does not reproduce. What survives can
// go straight into a report without being fact-checked. What does not survive
// is named, so you can see what the agent got wrong.
//
// Nothing here is specific to documentation, or to any one repo. A claim is a
// claim.
//
//   verify-claims <claims.json> [--json] [--root <dir>]
//   verify-claims --self-test
//
// Exit 1 if any claim was discarded, 2 on bad usage. Zero dependencies.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

// Resolved per run, not from this file's location: the tool is installed once
// and pointed at whatever repo you are standing in.
let ROOT = process.cwd();

function resolveRoot(explicit) {
  if (explicit) return resolve(explicit);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" });
  if (top.status === 0 && top.stdout.trim()) return resolve(top.stdout.trim());
  return process.cwd(); // not a git checkout; still usable
}

// CRLF is a checkout artifact, not content. A checker that splits on "\n"
// alone reports phantom mismatches on every file git wrote on Windows.
const lines = (text) => text.replace(/\r\n/g, "\n").split("\n");
const readIf = (p) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8") : null);
const posix = (p) => p.split(sep).join("/");

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "dist", "build", "vendor", "__pycache__"]);

let _files = null;
/**
 * Tracked files where git can say, everything else otherwise. Tracked is the
 * better answer when available: an untracked file is not in a clone, so it
 * cannot be evidence. A tracked path deleted from the working tree is dropped
 * either way, because there is nothing on disk to read or count.
 */
function listFiles() {
  if (_files) return _files;
  const out = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  if (out.status === 0) {
    return (_files = out.stdout.split("\n").filter((p) => p && existsSync(join(ROOT, p))));
  }
  const acc = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else acc.push(posix(relative(ROOT, join(dir, e.name))));
    }
  };
  walk(ROOT);
  return (_files = acc);
}

/**
 * Every path this file points at: markdown link targets, plus any bare
 * substring that resolves to a real file. The second half is what catches a
 * doc that names `src/thing.ts` in prose without linking it, and it needs no
 * per-repo configuration because the filesystem decides.
 */
function referencesFrom(text, fromDir, wantAbs) {
  for (const m of text.matchAll(/\]\(([^)#\s]+?)(?:#[^)]*)?\)/g)) {
    if (/^(https?:|mailto:|#)/.test(m[1])) continue;
    if (resolve(fromDir, m[1].replace(/[.,;:]+$/, "")) === wantAbs) return true;
  }
  return false;
}

/** Agent-authored JSON never becomes a shell command. Counting is declarative. */
function measure(ev) {
  const path = (ev.path ?? "").replace(/\/+$/, "");
  let re;
  try {
    re = ev.pattern ? new RegExp(ev.pattern) : null;
  } catch (e) {
    return { n: null, how: `bad pattern: ${e.message}` };
  }
  switch (ev.kind) {
    case "files": {
      const under = listFiles().filter((f) => f === path || f.startsWith(path + "/") || !path);
      const hits = re ? under.filter((f) => re.test(f)) : under;
      return { n: hits.length, how: `files under ${path || "."}${re ? ` matching /${ev.pattern}/` : ""}` };
    }
    case "dirs": {
      const kids = new Set(
        listFiles()
          .filter((f) => f.startsWith(path + "/"))
          .map((f) => f.slice(path.length + 1).split("/")[0])
          .filter((d) => d && (!re || re.test(d))),
      );
      return { n: kids.size, how: `child dirs of ${path}` };
    }
    case "lines": {
      const text = readIf(join(ROOT, path));
      if (text == null) return { n: null, how: `${path} does not exist` };
      return { n: lines(text).filter((l) => (re ? re.test(l) : l.trim() !== "")).length, how: `${re ? "matching" : "non-blank"} lines in ${path}` };
    }
    case "matches": {
      if (!ev.pattern) return { n: null, how: "count kind 'matches' requires a pattern" };
      const asFile = path && existsSync(join(ROOT, path)) && statSync(join(ROOT, path)).isFile();
      const files = asFile ? [path] : listFiles().filter((f) => !path || f.startsWith(path + "/"));
      let n = 0;
      for (const f of files) {
        const g = new RegExp(ev.pattern, "g");
        n += (readIf(join(ROOT, f)) ?? "").match(g)?.length ?? 0;
      }
      return { n, how: `/${ev.pattern}/g across ${files.length} file(s)` };
    }
    default:
      return { n: null, how: `unknown count kind: ${ev.kind}` };
  }
}

const OPS = { eq: (a, b) => a === b, gte: (a, b) => a >= b, lte: (a, b) => a <= b };

/** One evidence item -> { ok, detail }. Never throws on bad agent input. */
export function checkEvidence(ev) {
  try {
    switch (ev.type) {
      case "file_exists": {
        if (!ev.path) return { ok: false, detail: "file_exists needs a path" };
        const there = existsSync(join(ROOT, ev.path));
        const want = ev.absent !== true;
        return { ok: there === want, detail: `${ev.path} ${there ? "exists" : "does not exist"}; claim wanted it ${want ? "present" : "absent"}` };
      }
      case "line_content": {
        const text = readIf(join(ROOT, ev.file ?? ""));
        if (text == null) return { ok: false, detail: `${ev.file} does not exist` };
        if (ev.contains == null && ev.matches == null) return { ok: false, detail: "line_content needs contains or matches" };
        // A prose quote is not a line. Text reflows, so a quote worth checking
        // will span line breaks and collapse runs of spaces. With normalize the
        // file is flattened and the quote checked against that, which is the
        // only fair test of "did you actually read this".
        if (ev.normalize) {
          const needle = String(ev.contains ?? "").replace(/\s+/g, " ").trim();
          if (!needle) return { ok: false, detail: "normalize needs a non-empty contains" };
          const flat = lines(text).join(" ").replace(/\s+/g, " ").trim();
          return flat.includes(needle)
            ? { ok: true, detail: `quote reproduces in ${ev.file}` }
            : { ok: false, detail: `quote does not appear in ${ev.file}` };
        }
        const ls = lines(text);
        const hit = (l) => (ev.matches ? new RegExp(ev.matches).test(l) : String(l).includes(ev.contains));
        if (ev.line == null) {
          const at = ls.findIndex(hit);
          return at === -1 ? { ok: false, detail: `no line in ${ev.file} matches` } : { ok: true, detail: `${ev.file}:${at + 1} matches` };
        }
        const actual = ls[ev.line - 1];
        if (actual !== undefined && hit(actual)) return { ok: true, detail: `${ev.file}:${ev.line} matches` };
        // A cited line number that drifted is still a wrong citation: the agent
        // asserted a location it did not read. Report where the content is.
        const at = ls.findIndex(hit);
        return {
          ok: false,
          detail: at === -1
            ? `${ev.file}:${ev.line} does not match, and no other line does`
            : `${ev.file}:${ev.line} does not match; that content is at line ${at + 1}`,
        };
      }
      case "count": {
        const { n, how } = measure(ev);
        if (n == null) return { ok: false, detail: how };
        const op = OPS[ev.op ?? "eq"];
        if (!op) return { ok: false, detail: `unknown op: ${ev.op}` };
        return { ok: op(n, ev.expected), detail: `measured ${n} (${how}); claim said ${ev.op ?? "eq"} ${ev.expected}` };
      }
      case "cross_reference": {
        const from = ev.from ?? "";
        const text = readIf(join(ROOT, from));
        if (text == null) return { ok: false, detail: `${from} does not exist` };
        const want = ev.to ?? "";
        const target = join(ROOT, want);
        const linked = referencesFrom(text, dirname(join(ROOT, from)), resolve(target));
        // A bare mention counts too, but only when it names something real.
        const mentioned = text.includes(want);
        if (!linked && !mentioned) return { ok: false, detail: `${from} contains no reference to ${want}` };
        if (!existsSync(target)) return { ok: false, detail: `${from} -> ${want} is a dead reference` };
        if (ev.anchor) {
          const heads = lines(readFileSync(target, "utf8"))
            .filter((l) => l.startsWith("#"))
            .map((l) => l.replace(/^#+\s*/, "").toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-"));
          if (!heads.includes(ev.anchor.toLowerCase())) return { ok: false, detail: `${want} has no heading #${ev.anchor}` };
        }
        return { ok: true, detail: `${from} -> ${want} resolves` };
      }
      default:
        return { ok: false, detail: `unknown evidence type: ${ev.type}` };
    }
  } catch (e) {
    // A malformed regex from an agent is a failed claim, never a crashed run.
    return { ok: false, detail: `evidence threw: ${e.message}` };
  }
}

/** A claim survives only if it carries evidence AND every piece reproduces. */
export function verify(doc) {
  const claims = Array.isArray(doc) ? doc : (doc.claims ?? []);
  const verified = [];
  const discarded = [];
  claims.forEach((c, i) => {
    const id = c.id ?? `claim-${i + 1}`;
    const evidence = Array.isArray(c.evidence) ? c.evidence : [];
    if (evidence.length === 0) {
      discarded.push({ ...c, id, reason: "no evidence supplied", checks: [] });
      return;
    }
    const checks = evidence.map((ev) => ({ type: ev.type, ...checkEvidence(ev) }));
    const bad = checks.filter((r) => !r.ok);
    if (bad.length) discarded.push({ ...c, id, reason: bad.map((b) => b.detail).join("; "), checks });
    else verified.push({ ...c, id, checks });
  });
  return { verified, discarded, total: claims.length };
}

function report(r, json) {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return r.discarded.length ? 1 : 0;
  }
  console.log(`verify-claims: ${r.verified.length}/${r.total} claim(s) verified, ${r.discarded.length} discarded\n`);
  if (r.verified.length) {
    console.log("VERIFIED");
    for (const c of r.verified) {
      console.log(`  PASS ${c.id}  ${c.file ?? ""}${c.line ? `:${c.line}` : ""}  ${c.finding ?? ""}`);
      for (const k of c.checks) console.log(`       ${k.type}: ${k.detail}`);
    }
    console.log("");
  }
  if (r.discarded.length) {
    console.log("DISCARDED (failed verification; must not appear in the report)");
    for (const c of r.discarded) {
      console.log(`  FAIL ${c.id}  ${c.file ?? ""}${c.line ? `:${c.line}` : ""}  ${c.finding ?? ""}`);
      console.log(`       why: ${c.reason}`);
    }
  }
  return r.discarded.length ? 1 : 0;
}

// ---------------------------------------------------------------- self-test

/** Built from scratch in a temp dir: the suite must not depend on any repo. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "verify-claims-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Demo\n\nSee [the guide](docs/guide.md).\nAlso mentions docs/guide.md in prose.\n");
  // CRLF on purpose: the checker must not care how this was written to disk.
  writeFileSync(join(dir, "docs", "guide.md"), "# Guide\r\n\r\nThe timeout is 30\r\nseconds by default.\r\n\r\n## Options\r\n");
  writeFileSync(join(dir, "docs", "a.md"), "a\n");
  writeFileSync(join(dir, "docs", "b.md"), "b\n");
  return dir;
}

function selfTest() {
  const fails = [];
  const assert = (c, m) => { if (!c) fails.push(m); };
  const dir = fixture();
  const prevRoot = ROOT;
  ROOT = dir;
  _files = null;
  try {
    const one = (ev) => checkEvidence(ev);

    assert(one({ type: "file_exists", path: "docs/guide.md" }).ok, "existing file passes");
    assert(!one({ type: "file_exists", path: "docs/nope.md" }).ok, "missing file fails");
    assert(one({ type: "file_exists", path: "docs/nope.md", absent: true }).ok, "absence can be asserted");
    assert(!one({ type: "file_exists" }).ok, "file_exists with no path fails closed");

    assert(one({ type: "line_content", file: "docs/guide.md", line: 1, contains: "# Guide" }).ok, "correct line passes");
    const drift = one({ type: "line_content", file: "docs/guide.md", line: 99, contains: "# Guide" });
    assert(!drift.ok && /at line 1\b/.test(drift.detail), "a drifted line number fails and names the real line");
    assert(one({ type: "line_content", file: "docs/guide.md", contains: "Options" }).ok, "line may be omitted");
    assert(!one({ type: "line_content", file: "docs/guide.md", contains: "zzz" }).ok, "absent content fails");
    assert(!one({ type: "line_content", file: "docs/guide.md" }).ok, "no matcher fails closed");
    assert(one({ type: "line_content", file: "docs/guide.md", matches: "^## " }).ok, "regex matcher works");

    // CRLF: the fixture was written with \r\n and must read the same as \n.
    assert(lines("a\r\nb\r\n").length === lines("a\nb\n").length, "CRLF and LF split identically");
    assert(one({ type: "line_content", file: "docs/guide.md", line: 1, contains: "# Guide" }).ok, "CRLF file matches without a stray \\r");

    // normalize: a quote spanning a line break still has to be real.
    assert(one({ type: "line_content", file: "docs/guide.md", contains: "timeout is 30 seconds", normalize: true }).ok, "a reflowed quote reproduces");
    assert(!one({ type: "line_content", file: "docs/guide.md", contains: "never written here", normalize: true }).ok, "an invented quote fails under normalize");
    assert(!one({ type: "line_content", file: "docs/guide.md", contains: "  ", normalize: true }).ok, "an empty quote fails closed");

    assert(one({ type: "count", kind: "files", path: "docs", expected: 3 }).ok, "file count measures");
    assert(one({ type: "count", kind: "files", path: "docs", pattern: "\\.md$", expected: 3 }).ok, "pattern filters the count");
    assert(!one({ type: "count", kind: "files", path: "docs", expected: 99 }).ok, "a wrong count fails");
    assert(one({ type: "count", kind: "lines", path: "docs/a.md", expected: 1 }).ok, "line count measures");
    assert(one({ type: "count", kind: "matches", path: "README.md", pattern: "docs/guide\\.md", expected: 2 }).ok, "match count is per occurrence, not per file");
    assert(!one({ type: "count", kind: "matches", path: "README.md", expected: 1 }).ok, "matches without a pattern fails closed");
    assert(!one({ type: "count", kind: "files", path: "docs", expected: 1, op: "bogus" }).ok, "unknown op fails closed");
    assert(one({ type: "count", kind: "files", path: "docs", expected: 1, op: "gte" }).ok, "gte works");
    assert(!one({ type: "count", kind: "rm -rf /", path: ".", expected: 1 }).ok, "an unknown kind is refused, never executed");
    assert(!one({ type: "count", kind: "files", path: "docs", pattern: "(?i)bad", expected: 1 }).ok, "a malformed pattern fails the claim, it does not crash");

    assert(one({ type: "cross_reference", from: "README.md", to: "docs/guide.md" }).ok, "a markdown link resolves");
    assert(one({ type: "cross_reference", from: "README.md", to: "docs/guide.md", anchor: "options" }).ok, "an anchor that exists passes");
    assert(!one({ type: "cross_reference", from: "README.md", to: "docs/guide.md", anchor: "nope" }).ok, "a missing anchor fails");
    assert(!one({ type: "cross_reference", from: "README.md", to: "docs/a.md" }).ok, "an unreferenced file fails");
    assert(!one({ type: "cross_reference", from: "docs/nope.md", to: "docs/a.md" }).ok, "a missing source fails");

    assert(!one({ type: "unknown_type" }).ok, "an unknown evidence type fails closed");
    assert(!one({}).ok, "an empty evidence item fails closed");

    // A claim with no evidence is an opinion, and opinions are discarded.
    const r = verify({ claims: [
      { id: "a", finding: "real", evidence: [{ type: "file_exists", path: "docs/guide.md" }] },
      { id: "b", finding: "opinion", evidence: [] },
      { id: "c", finding: "half-true", evidence: [{ type: "file_exists", path: "docs/guide.md" }, { type: "file_exists", path: "docs/nope.md" }] },
    ] });
    assert(r.verified.length === 1 && r.verified[0].id === "a", "only fully-evidenced claims survive");
    assert(r.discarded.length === 2, "unevidenced and partly-false claims are both discarded");
    assert(r.discarded.some((d) => d.id === "c"), "one bad evidence item sinks the whole claim");
    assert(r.discarded.every((d) => d.reason), "every discard says why");
    assert(verify([{ id: "x", evidence: [{ type: "file_exists", path: "docs/a.md" }] }]).verified.length === 1, "a bare array of claims is accepted");
  } finally {
    ROOT = prevRoot;
    _files = null;
    rmSync(dir, { recursive: true, force: true });
  }
  if (fails.length) {
    console.error(`verify-claims --self-test: ${fails.length} FAILED`);
    for (const f of fails) console.error(`  FAIL: ${f}`);
    process.exit(1);
  }
  console.log("verify-claims --self-test: OK");
}

// -------------------------------------------------------------------- entry

const invokedDirectly = resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flagValue = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
  ROOT = resolveRoot(flagValue("--root"));
  if (argv.includes("--self-test")) selfTest();
  else {
    const file = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--root");
    if (!file) { console.error("usage: verify-claims <claims.json> [--json] [--root <dir>]"); process.exit(2); }
    if (!existsSync(file)) { console.error(`verify-claims: no such claims file: ${file}`); process.exit(2); }
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`verify-claims: ${file} is not valid JSON: ${e.message}`);
      process.exit(2);
    }
    process.exit(report(verify(doc), argv.includes("--json")));
  }
}
