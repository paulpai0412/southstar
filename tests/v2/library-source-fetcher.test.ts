import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fetchLibraryImportSourceDocuments,
  type LibraryImportSourceFetcher,
} from "../../src/v2/design-library/importers/library-source-fetcher.ts";

test("fetchLibraryImportSourceDocuments delegates github sources without inline content to the injected fetcher and bounds returned docs", async () => {
  const calls: unknown[] = [];
  const fetcher: LibraryImportSourceFetcher = async (input) => {
    calls.push(input);
    return [
      { path: "agents/reviewer.md", label: "reviewer", content: "# Reviewer\nUses skill.review." },
      { path: "skills/review.md", label: "review", content: "# Review\nRequires tool.github." },
      { path: "tools/github.yaml", label: "github", content: "name: github" },
    ];
  };

  const docs = await fetchLibraryImportSourceDocuments({
    source: { kind: "github", repoUrl: "https://github.com/acme/library", path: "library" },
    sourceFetcher: fetcher,
    maxFiles: 2,
    maxBytes: 1_000,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    source: { kind: "github", repoUrl: "https://github.com/acme/library", path: "library" },
  });
  assert.deepEqual(docs.map((doc) => doc.path), ["agents/reviewer.md", "skills/review.md"]);
});

test("fetchLibraryImportSourceDocuments reads local folders recursively in sorted order and ignores dependency/control directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-source-"));
  try {
    await mkdir(join(root, "skills"), { recursive: true });
    await mkdir(join(root, "agents"), { recursive: true });
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "skills/review.skill.md"), "# Review Skill", "utf8");
    await writeFile(join(root, "agents/reviewer.agent.md"), "# Reviewer Agent", "utf8");
    await writeFile(join(root, "README.txt"), "ignored text file", "utf8");
    await writeFile(join(root, "node_modules/pkg/ignored.md"), "# ignored dependency", "utf8");
    await writeFile(join(root, ".git/ignored.md"), "# ignored git metadata", "utf8");

    const docs = await fetchLibraryImportSourceDocuments({
      source: { kind: "local", absolutePath: root },
      localRoot: root,
      maxFiles: 10,
      maxBytes: 1_000,
    });

    assert.deepEqual(docs.map((doc) => doc.path), ["agents/reviewer.agent.md", "skills/review.skill.md"]);
    assert.deepEqual(docs.map((doc) => doc.content), ["# Reviewer Agent", "# Review Skill"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fetchLibraryImportSourceDocuments rejects local sources that exceed maxFiles or maxBytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-source-bounds-"));
  try {
    await writeFile(join(root, "one.md"), "# one", "utf8");
    await writeFile(join(root, "two.md"), "# two", "utf8");

    await assert.rejects(
      () => fetchLibraryImportSourceDocuments({
        source: { kind: "local", absolutePath: root },
        localRoot: root,
        maxFiles: 1,
        maxBytes: 1_000,
      }),
      /library import source has too many documents/,
    );

    await assert.rejects(
      () => fetchLibraryImportSourceDocuments({
        source: { kind: "local", absolutePath: join(root, "one.md") },
        localRoot: root,
        maxFiles: 10,
        maxBytes: 2,
      }),
      /library import source exceeds maxBytes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fetchLibraryImportSourceDocuments sanitizes paste labels and rejects local path traversal outside the configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-source-root-"));
  const outside = await mkdtemp(join(tmpdir(), "southstar-library-source-outside-"));
  try {
    await writeFile(join(outside, "escape.md"), "# escape", "utf8");

    const docs = await fetchLibraryImportSourceDocuments({
      source: { kind: "paste", label: "../Browser Skill!!", content: "# pasted" },
      maxFiles: 10,
      maxBytes: 1_000,
    });
    assert.equal(docs[0]?.path, "Browser-Skill.md");
    assert.equal(docs[0]?.label, "Browser Skill");

    await assert.rejects(
      () => fetchLibraryImportSourceDocuments({
        source: { kind: "local", absolutePath: join(outside, "escape.md") },
        localRoot: root,
        maxFiles: 10,
        maxBytes: 1_000,
      }),
      /local import source must resolve under localRoot/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
