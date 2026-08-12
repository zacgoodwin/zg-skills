// Fold the deterministic verdict-file gate into a grader output. Usage:
//   bun evals/lib/merge-grade.ts <grade-raw.txt> <singleResult> <adversarialResult>
//
// The grader is only asked the latent question (defect matching); the
// "marker" fields recall.ts scores for gate 2 are the verdict files' own
// `result` values, computed by run.sh via lib/verdict.ts check -- so the gate
// is never a model's claim about itself. When the grader output carries no
// parseable JSON object, the raw text is passed through unchanged so
// recall.ts reports it UNREADABLE (a harness error, never a graded miss).
import { readFileSync } from "node:fs";
import { extractJsonObject } from "./grade.ts";

const [rawPath, singleResult, adversarialResult] = process.argv.slice(2);
if (!rawPath || !singleResult || !adversarialResult) {
  process.stderr.write("usage: bun evals/lib/merge-grade.ts <grade-raw.txt> <singleResult> <adversarialResult>\n");
  process.exit(2);
}
const raw = readFileSync(rawPath, "utf8");
const json = extractJsonObject(raw);
if (json === null) {
  process.stdout.write(raw);
  process.exit(0);
}
let parsed: unknown;
try {
  parsed = JSON.parse(json);
} catch {
  process.stdout.write(raw);
  process.exit(0);
}
const merged = {
  ...(parsed as Record<string, unknown>),
  singleMarker: singleResult,
  adversarialMarker: adversarialResult,
};
process.stdout.write(JSON.stringify(merged));
