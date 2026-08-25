// Gate tests for lib/bundle.ts: region boundaries (the false-positive
// suppressor), heading parsing under fences, per-lens visibility, multi-doc
// addressing, and the bundle directory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextWindow,
  ensureGitignored,
  expandPaths,
  lensSeesLine,
  loadBundle,
  loadDoc,
  MAX_BUNDLE_LINES,
  parseHeadings,
  sectionEnd,
  slugify,
  splitLines,
  tagRegions,
  visibleLines,
  writeBundleDir,
  type RegionKind,
} from "../lib/bundle.ts";
import { ZError } from "../lib/cli.ts";

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bundle-test-"));
});
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

function write(name: string, body: string): string {
  const p = join(scratch, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
}

// Region kinds for a 1-based line, sorted for stable comparison.
function at(regions: RegionKind[][], line: number): RegionKind[] {
  return [...regions[line - 1]].sort();
}

describe("splitLines", () => {
  test("normalizes CRLF so a Windows-captured quote resolves either way", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });

  test("drops only the trailing-newline artifact, keeps real blank lines", () => {
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("slugify", () => {
  test("matches the common anchor convention", () => {
    expect(slugify("Getting Started")).toBe("getting-started");
    expect(slugify("`code` and **bold**")).toBe("code-and-bold");
    expect(slugify("What's new?")).toBe("whats-new");
    expect(slugify("A -- B")).toBe("a-b");
    expect(slugify("[link](http://x)")).toBe("link");
  });
});

describe("fences", () => {
  test("everything between fences is code, fence lines included", () => {
    const { regions } = tagRegions(["prose", "```js", "const x = 1;", "```", "after"]);
    expect(at(regions, 1)).toEqual([]);
    expect(at(regions, 2)).toEqual(["code"]);
    expect(at(regions, 3)).toEqual(["code"]);
    expect(at(regions, 4)).toEqual(["code"]);
    expect(at(regions, 5)).toEqual([]);
  });

  test("a heading inside a fence is not a heading", () => {
    const lines = ["# Real", "```", "# Not a heading", "```"];
    const { regions, headings } = tagRegions(lines);
    expect(headings.map((h) => h.text)).toEqual(["Real"]);
    expect(at(regions, 3)).toEqual(["code"]);
  });

  test("a shorter fence inside a longer one does not close it", () => {
    const { regions } = tagRegions(["````", "```", "still code", "````", "out"]);
    expect(at(regions, 3)).toEqual(["code"]);
    expect(at(regions, 5)).toEqual([]);
  });

  test("a closing fence must carry no info string", () => {
    const { regions } = tagRegions(["```", "x", "``` not-a-close", "y", "```", "out"]);
    expect(at(regions, 4)).toEqual(["code"]);
    expect(at(regions, 6)).toEqual([]);
  });

  test("tilde fences work and do not close backtick fences", () => {
    const { regions } = tagRegions(["~~~", "x", "```", "y", "~~~", "out"]);
    expect(at(regions, 4)).toEqual(["code"]);
    expect(at(regions, 6)).toEqual([]);
  });

  test("an unclosed fence runs to EOF", () => {
    const { regions } = tagRegions(["prose", "```", "x", "y"]);
    expect(at(regions, 4)).toEqual(["code"]);
  });
});

describe("frontmatter", () => {
  test("a leading delimited block is tagged", () => {
    const { regions } = tagRegions(["---", "title: x", "---", "body"]);
    expect(at(regions, 1)).toEqual(["frontmatter"]);
    expect(at(regions, 2)).toEqual(["frontmatter"]);
    expect(at(regions, 3)).toEqual(["frontmatter"]);
    expect(at(regions, 4)).toEqual([]);
  });

  test("an unterminated opener is a horizontal rule, not the whole file", () => {
    const { regions } = tagRegions(["---", "body", "more"]);
    expect(at(regions, 2)).toEqual([]);
    expect(at(regions, 3)).toEqual([]);
  });

  test("a --- further down is not frontmatter", () => {
    const { regions } = tagRegions(["body", "---", "more", "---"]);
    expect(at(regions, 3)).toEqual([]);
  });
});

describe("headings", () => {
  test("ATX levels and trailing hashes", () => {
    const lines = ["# One", "### Three ###", "text"];
    const { headings } = tagRegions(lines);
    expect(headings).toEqual([
      { line: 1, level: 1, text: "One", slug: "one" },
      { line: 2, level: 3, text: "Three", slug: "three" },
    ]);
  });

  test("setext headings are recognized, so older docs still shard", () => {
    const lines = ["Title", "=====", "", "Sub", "-----", "body"];
    const { headings } = tagRegions(lines);
    expect(headings.map((h) => [h.line, h.level, h.text])).toEqual([
      [1, 1, "Title"],
      [4, 2, "Sub"],
    ]);
  });

  test("a --- after a blank line is a rule, not a setext heading", () => {
    const { headings } = parseHeadingsOf(["body", "", "---", "more"]);
    expect(headings).toEqual([]);
  });

  function parseHeadingsOf(lines: string[]) {
    const { headings } = tagRegions(lines);
    return { headings };
  }

  test("sectionEnd stops at the next same-or-higher heading", () => {
    const lines = ["# A", "x", "## B", "y", "### C", "z", "## D", "w"];
    const { headings } = tagRegions(lines);
    // A (level 1) runs to EOF; B (level 2) stops before D (level 2).
    expect(sectionEnd(headings, 0, lines.length)).toBe(8);
    expect(sectionEnd(headings, 1, lines.length)).toBe(6);
    expect(sectionEnd(headings, 2, lines.length)).toBe(6);
    expect(sectionEnd(headings, 3, lines.length)).toBe(8);
  });
});

describe("history and example sections", () => {
  test("a changelog section is tagged through its content", () => {
    const lines = ["# Docs", "current behavior", "## Changelog", "- old behavior", "## Usage", "current again"];
    const { regions } = tagRegions(lines);
    expect(at(regions, 2)).toEqual([]);
    expect(at(regions, 3)).toEqual(["history"]);
    expect(at(regions, 4)).toEqual(["history"]);
    expect(at(regions, 5)).toEqual([]);
    expect(at(regions, 6)).toEqual([]);
  });

  test("the history heading vocabulary covers the common spellings", () => {
    for (const h of ["Change Log", "Release Notes", "Migration Guide", "Deprecated", "Upgrading", "Legacy", "Prior Behavior"]) {
      const { regions } = tagRegions([`## ${h}`, "content"]);
      expect(at(regions, 2)).toEqual(["history"]);
    }
  });

  test("example and anti-pattern sections are tagged", () => {
    for (const h of ["Examples", "Anti-Patterns", "What Not To Do", "Before / After", "Don'ts", "Incorrect"]) {
      const { regions } = tagRegions([`## ${h}`, "content"]);
      expect(at(regions, 2)).toEqual(["example"]);
    }
  });

  test("a nested subsection inherits its parent history region", () => {
    const lines = ["## Changelog", "### v1.0", "old thing", "## Now", "new thing"];
    const { regions } = tagRegions(lines);
    expect(at(regions, 3)).toEqual(["history"]);
    expect(at(regions, 5)).toEqual([]);
  });

  test("a heading merely mentioning history mid-phrase is not a history section", () => {
    const { regions } = tagRegions(["## Command history configuration", "content"]);
    expect(at(regions, 2)).toEqual([]);
  });

  test("regions stack: a fence inside an example section carries both", () => {
    const lines = ["## Examples", "```", "code", "```"];
    const { regions } = tagRegions(lines);
    expect(at(regions, 3)).toEqual(["code", "example"]);
  });
});

describe("blockquotes", () => {
  test("quoted lines are tagged, but not inside a fence", () => {
    const { regions } = tagRegions(["> quoted", "```", "> not a quote", "```"]);
    expect(at(regions, 1)).toEqual(["quote"]);
    expect(at(regions, 3)).toEqual(["code"]);
  });
});

describe("per-lens visibility", () => {
  const lines = [
    "# Doc", //             1  prose
    "Timeout is 60s.", //   2  prose
    "```yaml", //           3  code
    "timeout: 30", //       4  code
    "```", //               5  code
    "## Changelog", //      6  history
    "Timeout was 10s.", //  7  history
    "## Examples", //       8  example
    "> quoted bit", //      9  example + quote
  ];

  function doc() {
    const p = write("vis.md", lines.join("\n") + "\n");
    return loadDoc(p, "D1", scratch);
  }

  test("contradiction and terminology ignore every excluded region", () => {
    const d = doc();
    expect(visibleLines(d, "contradiction")).toEqual([1, 2]);
    expect(visibleLines(d, "terminology")).toEqual([1, 2]);
  });

  test("numeric reads code fences on purpose, so a sample can contradict prose", () => {
    const d = doc();
    expect(visibleLines(d, "numeric")).toEqual([1, 2, 3, 4, 5]);
    expect(lensSeesLine(d, 4, "numeric")).toBe(true);
    expect(lensSeesLine(d, 4, "contradiction")).toBe(false);
  });

  test("structure reads history and example sections, because their headings are real", () => {
    const d = doc();
    expect(visibleLines(d, "structure")).toEqual([1, 2, 6, 7, 8, 9]);
  });

  test("an out-of-range line is invisible rather than a crash", () => {
    const d = doc();
    expect(lensSeesLine(d, 999, "contradiction")).toBe(false);
    expect(lensSeesLine(d, 0, "contradiction")).toBe(false);
  });
});

describe("expandPaths", () => {
  test("preserves argument order and dedupes", () => {
    write("ep/b.md", "b\n");
    write("ep/a.md", "a\n");
    const got = expandPaths(["ep/b.md", "ep/a.md", "ep/b.md"], scratch);
    expect(got.map((p) => p.replace(/\\/g, "/").split("/").pop())).toEqual(["b.md", "a.md"]);
  });

  test("globs expand in sorted order for reproducibility", () => {
    write("gl/2.md", "x\n");
    write("gl/1.md", "x\n");
    const got = expandPaths(["gl/*.md"], scratch);
    expect(got.map((p) => p.replace(/\\/g, "/").split("/").pop())).toEqual(["1.md", "2.md"]);
  });

  test("a glob quietly skips unsupported extensions, a named file does not", () => {
    write("mix/a.md", "x\n");
    write("mix/b.png", "x\n");
    expect(expandPaths(["mix/*"], scratch)).toHaveLength(1);
    expect(() => expandPaths(["mix/b.png"], scratch)).toThrow(ZError);
  });

  test("a glob matching nothing is an error, not an empty review", () => {
    expect(() => expandPaths(["nope/*.md"], scratch)).toThrow(/matched no files/);
  });

  test("a missing named file is an error", () => {
    expect(() => expandPaths(["nope.md"], scratch)).toThrow(/not a file/);
  });

  test("no arguments is an error", () => {
    expect(() => expandPaths([], scratch)).toThrow(/No documents given/);
  });
});

describe("loadBundle", () => {
  test("assigns ids in argument order and counts lines", () => {
    write("lb/one.md", "a\nb\n");
    write("lb/two.md", "c\n");
    const b = loadBundle(["lb/one.md", "lb/two.md"], scratch, scratch);
    expect(b.docs.map((d) => d.id)).toEqual(["D1", "D2"]);
    expect(b.docs[0].relPath).toBe("lb/one.md");
    expect(b.totalLines).toBe(3);
  });

  test("relPath always uses forward slashes", () => {
    write("lb/nested/deep.md", "x\n");
    const b = loadBundle(["lb/nested/deep.md"], scratch, scratch);
    expect(b.docs[0].relPath).toBe("lb/nested/deep.md");
    expect(b.docs[0].relPath).not.toContain("\\");
  });

  test("the line ceiling is enforced with an actionable message", () => {
    write("big.md", "x\n".repeat(MAX_BUNDLE_LINES + 1));
    expect(() => loadBundle(["big.md"], scratch, scratch)).toThrow(/ceiling is 25000/);
  });
});

describe("writeBundleDir", () => {
  test("copies documents flat and writes a manifest", () => {
    write("bd/a.md", "one\ntwo\n");
    write("bd/b.txt", "three\n");
    const b = loadBundle(["bd/a.md", "bd/b.txt"], scratch, scratch);
    const dir = join(scratch, "bundle-out");
    const manifest = writeBundleDir(b, dir);

    expect(manifest.docs.map((d) => d.file)).toEqual(["D1-a.md", "D2-b.txt"]);
    expect(manifest.totalLines).toBe(3);
    expect(readFileSync(join(dir, "D1-a.md"), "utf8")).toBe("one\ntwo\n");
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).docs).toHaveLength(2);
  });

  test("the copy carries no repo layout an agent could infer", () => {
    write("bd2/secret-dir/a.md", "x\n");
    const b = loadBundle(["bd2/secret-dir/a.md"], scratch, scratch);
    const dir = join(scratch, "bundle-out-2");
    writeBundleDir(b, dir);
    expect(existsSync(join(dir, "D1-a.md"))).toBe(true);
    expect(existsSync(join(dir, "bd2"))).toBe(false);
  });
});

describe("contextWindow", () => {
  test("numbers lines and marks the site", () => {
    const p = write("cw.md", "one\ntwo\nthree\nfour\nfive\n");
    const d = loadDoc(p, "D1", scratch);
    expect(contextWindow(d, 3, 1)).toBe("2   two\n3 > three\n4   four");
  });

  test("clamps at both document edges", () => {
    const p = write("cw2.md", "one\ntwo\n");
    const d = loadDoc(p, "D1", scratch);
    expect(contextWindow(d, 1, 5)).toBe("1 > one\n2   two");
  });

  test("a line outside the document is an error, not an empty window", () => {
    const p = write("cw3.md", "one\n");
    const d = loadDoc(p, "D1", scratch);
    expect(() => contextWindow(d, 2, 1)).toThrow(/outside D1/);
  });
});

describe("ensureGitignored", () => {
  test("adds the entry once and is idempotent", () => {
    const root = join(scratch, "gi");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    expect(ensureGitignored(root)).toBe("added");
    expect(ensureGitignored(root)).toBe("already-present");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n.doc-integrity/\n");
  });

  test("a repo with no .gitignore is left alone", () => {
    const root = join(scratch, "gi2");
    mkdirSync(root, { recursive: true });
    expect(ensureGitignored(root)).toBe("no-gitignore");
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });
});
