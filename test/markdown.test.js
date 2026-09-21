import { test } from "node:test";
import assert from "node:assert/strict";
import { appendSection, parseMarkdown, docTitle, replaceSectionBody } from "../src/markdown.js";

test("parseMarkdown builds nested heading paths and excludes H1", () => {
  const md = "# Title\n\nintro\n\n## Arch\n\ntop\n\n### Arch::Storage\n\nnested\n";
  const parsed = parseMarkdown(md);
  const paths = parsed.sections.map((s) => s.path);
  assert.deepEqual(paths, ["", "Arch", "Arch::Arch::Storage"]);
});

test("parseMarkdown detects frontmatter", () => {
  const parsed = parseMarkdown("---\ntitle: My Doc\n---\n\nbody");
  assert.equal(parsed.frontmatter, "---\ntitle: My Doc\n---");
  assert.equal(docTitle(parsed, "fallback.md"), "My Doc");
});

test("docTitle falls back to H1 then filename", () => {
  assert.equal(docTitle(parseMarkdown("# H\n"), "x.md"), "H");
  assert.equal(docTitle(parseMarkdown("no heads"), "x.md"), "x");
});

test("replaceSectionBody splices only the target section", () => {
  const md = "# T\n\n## A\n\nold body\n\n## B\n\nkeep me\n";
  const parsed = parseMarkdown(md);
  const secA = parsed.sections.find((s) => s.path === "A");
  const out = replaceSectionBody(md, secA, "new body");
  assert.match(out, /new body/);
  assert.doesNotMatch(out, /old body/);
  assert.match(out, /keep me/);
  assert.match(out, /^# T/);
});

test("appendSection adds a missing section at the end", () => {
  const md = "# T\n\n## Existing\n\nkeep me\n";
  assert.equal(appendSection(md, "Added", "new body"), `${md}\n## Added\n\nnew body\n`);
});
