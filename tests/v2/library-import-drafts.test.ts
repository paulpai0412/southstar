import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listLibraryFiles } from "../../src/v2/design-library/files/library-file-store.ts";
import { createLibraryImportDraft, approveLibraryImportDraft } from "../../src/v2/design-library/importers/library-import-draft-store.ts";
import { asImportSource, extractLibraryImportProposal } from "../../src/v2/design-library/importers/library-import-extractor.ts";
import { extractLibraryCandidatesFromDocuments } from "../../src/v2/design-library/importers/library-candidate-extractor.ts";
import {
  analyzeLibraryImportWithLlm,
  type LibraryImportLlmProvider,
} from "../../src/v2/design-library/importers/library-llm-import-analyzer.ts";
import type { LibraryImportSourceFetcher } from "../../src/v2/design-library/importers/library-source-fetcher.ts";
import { parseLibraryFileContent } from "../../src/v2/design-library/files/library-file-parser.ts";
import { findLibraryObjectByKey, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("createLibraryImportDraft creates a runtime draft without writing library files", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-draft-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });

    assert.match(draft.draftId, /^library-import-draft-/);
    assert.equal(draft.status, "draft");
    assert.deepEqual(draft.proposal.objectKeys, ["skill.browser-verification"]);
    assert.equal(draft.proposal.files[0]?.relativePath, "skills/browser-verification.skill.md");
    assert.deepEqual(draft.proposal.objectSummaries, [{
      objectKey: "skill.browser-verification",
      objectKind: "skill_spec",
      title: "Browser Verification",
      scope: "software",
      status: "draft",
      relativePath: "skills/browser-verification.skill.md",
    }]);
    assert.deepEqual(draft.proposal.dependencies, [
      {
        fromObjectKey: "skill.browser-verification",
        edgeType: "requires_capability",
        toObjectKey: "capability.browser-verification",
        scope: "software",
      },
      {
        fromObjectKey: "skill.browser-verification",
        edgeType: "requires_tool",
        toObjectKey: "tool.browser",
        scope: "software",
      },
    ]);
    assert.deepEqual(await listLibraryFiles({ root: libraryRoot }), []);

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(resource?.status, "draft");
    assert.equal(resource?.scope, "library");
    assert.equal((resource?.payload as any).schemaVersion, "southstar.library.import_draft.v1");
    assert.deepEqual((resource?.payload as any).proposal.objectKeys, ["skill.browser-verification"]);
    assert.equal((resource?.payload as any).proposal.objectSummaries[0].title, "Browser Verification");
    assert.equal((resource?.payload as any).proposal.dependencies[0].toObjectKey, "capability.browser-verification");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("createLibraryImportDraft accepts canonical paste source and persists kind-discriminated source", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-canonical-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });

    assert.equal(draft.status, "draft");
    assert.equal(draft.proposal.files[0]?.relativePath, "skills/browser-verification.skill.md");
    assert.deepEqual(await listLibraryFiles({ root: libraryRoot }), []);

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.deepEqual((resource?.payload as any).source, {
      kind: "paste",
      label: "browser skill prompt",
      content: "create a browser verification skill that uses tool.browser",
    });
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("extractor accepts canonical github and local sources with inline content for deterministic import", () => {
  const githubProposal = extractLibraryImportProposal({
    source: {
      kind: "github",
      repoUrl: "https://github.com/acme/library",
      path: "skills/browser.md",
      content: "create a browser verification skill that uses tool.browser",
    },
    scope: "software",
  });
  assert.deepEqual(githubProposal.objectKeys, ["skill.browser-verification"]);

  const localProposal = extractLibraryImportProposal({
    source: {
      kind: "local",
      absolutePath: "/tmp/browser.md",
      content: "create a browser verification skill that uses tool.browser",
    },
    scope: "software",
  });
  assert.equal(localProposal.files[0]?.relativePath, "skills/browser-verification.skill.md");
});

test("extractLibraryCandidatesFromDocuments deterministically classifies obvious library docs and proposes simple edges", () => {
  const result = extractLibraryCandidatesFromDocuments({
    scope: "software",
    documents: [
      { path: "agents/reviewer.agent.md", label: "Reviewer", content: "# Reviewer\nUses the review skill." },
      { path: "skills/review.skill.md", label: "Review", content: "# Review\nRequires GitHub tooling." },
      { path: "tools/github.tool.yaml", label: "GitHub", content: "name: github" },
      { path: "mcp/filesystem.mcp.yaml", label: "Filesystem", content: "name: filesystem" },
    ],
  });

  assert.deepEqual(result.candidates.map((candidate) => ({
    objectKey: candidate.objectKey,
    kind: candidate.kind,
    selectedByDefault: candidate.selectedByDefault,
  })), [
    { objectKey: "agent.reviewer", kind: "agent", selectedByDefault: true },
    { objectKey: "skill.review", kind: "skill", selectedByDefault: true },
    { objectKey: "tool.github", kind: "tool", selectedByDefault: true },
    { objectKey: "mcp.filesystem", kind: "mcp", selectedByDefault: true },
  ]);
  assert.deepEqual(result.proposedEdges, [
    {
      fromObjectKey: "agent.reviewer",
      edgeType: "uses",
      toObjectKey: "skill.review",
      confidence: 0.6,
      rationale: "Detected one agent and one skill in imported documents.",
    },
    {
      fromObjectKey: "skill.review",
      edgeType: "requires",
      toObjectKey: "mcp.filesystem",
      confidence: 0.6,
      rationale: "Detected skill and imported MCP grant documents.",
    },
    {
      fromObjectKey: "skill.review",
      edgeType: "requires",
      toObjectKey: "tool.github",
      confidence: 0.6,
      rationale: "Detected skill and imported tool documents.",
    },
  ]);
});

test("analyzeLibraryImportWithLlm prompts for classification and ontology edges and normalizes provider output", async () => {
  const prompts: string[] = [];
  const provider: LibraryImportLlmProvider = async (input) => {
    prompts.push(input.prompt);
    return {
      candidates: [
        { objectKey: "agent.reviewer", kind: "agent", title: "Reviewer", selectedByDefault: true, confidence: 0.8 },
        { objectKey: "skill.review", kind: "skill", title: "Review", selectedByDefault: true, confidence: -0.5 },
      ],
      proposedEdges: [
        { fromObjectKey: "agent.reviewer", edgeType: "uses", toObjectKey: "skill.review", confidence: 1.2 },
        { fromObjectKey: "agent.reviewer", edgeType: "contains", toObjectKey: "skill.review", confidence: 0.9 },
        { fromObjectKey: "agent.missing", edgeType: "uses", toObjectKey: "skill.review", confidence: 0.9 },
      ],
    };
  };

  const result = await analyzeLibraryImportWithLlm({
    scope: "software",
    documents: [
      { path: "agents/reviewer.agent.md", label: "Reviewer", content: "# Reviewer" },
      { path: "skills/review.skill.md", label: "Review", content: "# Review" },
    ],
    llmProvider: provider,
  });

  assert.match(prompts[0] ?? "", /classify/i);
  assert.match(prompts[0] ?? "", /ontology edges/i);
  assert.equal(result.candidates[0]?.confidence, 0.8);
  assert.equal(result.candidates[1]?.confidence, 0);
  assert.deepEqual(result.proposedEdges, [
    {
      fromObjectKey: "agent.reviewer",
      edgeType: "uses",
      toObjectKey: "skill.review",
      confidence: 1,
    },
  ]);
});

test("analyzeLibraryImportWithLlm accepts full ontology edge vocabulary and drops candidates with untrusted source paths", async () => {
  const prompts: string[] = [];
  const provider: LibraryImportLlmProvider = async (input) => {
    prompts.push(input.prompt);
    return {
      candidates: [
        { objectKey: "agent.reviewer", kind: "agent", title: "Reviewer", sourcePath: "agents/reviewer.agent.md" },
        { objectKey: "skill.review", kind: "skill", title: "Review", sourcePath: "skills/review.skill.md" },
        { objectKey: "skill.audit", kind: "skill", title: "Audit", sourcePath: "skills/audit.skill.md" },
        { objectKey: "tool.github", kind: "tool", title: "GitHub", sourcePath: "tools/github.tool.yaml" },
        { objectKey: "skill.untrusted", kind: "skill", title: "Untrusted", sourcePath: "missing.md" },
      ],
      edges: [
        { fromObjectKey: "agent.reviewer", edgeType: "uses", toObjectKey: "skill.review", confidence: 0.9 },
        { fromObjectKey: "skill.review", edgeType: "conflicts_with", toObjectKey: "tool.github", confidence: 0.7 },
        { fromObjectKey: "skill.review", edgeType: "workflow_precedes", toObjectKey: "skill.audit", confidence: 0.8 },
        { fromObjectKey: "skill.review", edgeType: "similar_to", toObjectKey: "skill.audit", confidence: 0.6 },
        { fromObjectKey: "skill.review", edgeType: "contains", toObjectKey: "skill.audit", confidence: 1 },
        { fromObjectKey: "skill.review", edgeType: "similar_to", toObjectKey: "skill.untrusted", confidence: 1 },
      ],
    };
  };

  const result = await analyzeLibraryImportWithLlm({
    scope: "software",
    documents: [
      { path: "agents/reviewer.agent.md", label: "Reviewer", content: "# Reviewer" },
      { path: "skills/review.skill.md", label: "Review", content: "# Review" },
      { path: "skills/audit.skill.md", label: "Audit", content: "# Audit" },
      { path: "tools/github.tool.yaml", label: "GitHub", content: "name: github" },
    ],
    llmProvider: provider,
  });

  assert.match(prompts[0] ?? "", /conflicts_with/);
  assert.match(prompts[0] ?? "", /workflow_precedes/);
  assert.match(prompts[0] ?? "", /similar_to/);
  assert.deepEqual(result.candidates.map((candidate) => candidate.objectKey), [
    "agent.reviewer",
    "skill.review",
    "skill.audit",
    "tool.github",
  ]);
  assert.deepEqual(result.proposedEdges.map((edge) => ({
    fromObjectKey: edge.fromObjectKey,
    edgeType: edge.edgeType,
    toObjectKey: edge.toObjectKey,
  })), [
    { fromObjectKey: "agent.reviewer", edgeType: "uses", toObjectKey: "skill.review" },
    { fromObjectKey: "skill.review", edgeType: "conflicts_with", toObjectKey: "tool.github" },
    { fromObjectKey: "skill.review", edgeType: "workflow_precedes", toObjectKey: "skill.audit" },
    { fromObjectKey: "skill.review", edgeType: "similar_to", toObjectKey: "skill.audit" },
  ]);
});

test("createLibraryImportDraft preserves the legacy proposal and persists analyzed documents, candidates, and proposed edges", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-analysis-"));
  const provider: LibraryImportLlmProvider = async () => ({
    candidates: [
      { objectKey: "agent.browser-reviewer", kind: "agent", title: "Browser Reviewer", selectedByDefault: true, confidence: 0.9 },
      { objectKey: "skill.browser-verification", kind: "skill", title: "Browser Verification", selectedByDefault: true, confidence: 0.9 },
    ],
    proposedEdges: [
      { fromObjectKey: "agent.browser-reviewer", edgeType: "uses", toObjectKey: "skill.browser-verification", confidence: 1.2 },
    ],
  });

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
      llmProvider: provider,
    });

    assert.deepEqual(draft.proposal.objectKeys, ["skill.browser-verification"]);
    assert.deepEqual(draft.documents?.map((doc) => doc.path), ["browser-skill-prompt.md"]);
    assert.deepEqual(draft.candidates?.map((candidate) => candidate.objectKey), [
      "agent.browser-reviewer",
      "skill.browser-verification",
    ]);
    assert.deepEqual(draft.proposedEdges, [
      {
        fromObjectKey: "agent.browser-reviewer",
        edgeType: "uses",
        toObjectKey: "skill.browser-verification",
        confidence: 1,
      },
    ]);
    assert.deepEqual(await listLibraryFiles({ root: libraryRoot }), []);

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.deepEqual((resource?.payload as any).proposal.objectKeys, ["skill.browser-verification"]);
    assert.deepEqual((resource?.payload as any).documents.map((doc: any) => doc.path), ["browser-skill-prompt.md"]);
    assert.deepEqual((resource?.payload as any).candidates.map((candidate: any) => candidate.objectKey), [
      "agent.browser-reviewer",
      "skill.browser-verification",
    ]);
    assert.equal((resource?.payload as any).proposedEdges[0].confidence, 1);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft writes proposed files and syncs them to the graph", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-approve-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });

    const approved = await approveLibraryImportDraft(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      actor: "operator",
      reason: "reviewed generated draft",
    });

    assert.equal(approved.draftId, draft.draftId);
    assert.equal(approved.status, "approved");
    assert.deepEqual(
      approved.files.map((file) => file.relativePath),
      ["skills/browser-verification.skill.md"],
    );
    assert.equal(approved.synced[0]?.object.objectKey, "skill.browser-verification");

    const content = await readFile(join(libraryRoot, "skills/browser-verification.skill.md"), "utf8");
    const parsed = parseLibraryFileContent({ path: "library/skills/browser-verification.skill.md", content });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("expected approved import file to parse");
    assert.equal(parsed.file.id, "skill.browser-verification");
    assert.equal(parsed.file.status, "draft");

    const object = await findLibraryObjectByKey(db, "skill.browser-verification");
    assert.equal(object?.objectKind, "skill_spec");
    assert.equal(object?.status, "draft");

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(resource?.status, "approved");
    assert.equal((resource?.payload as any).approval.actor, "operator");
    assert.equal((resource?.payload as any).approval.reason, "reviewed generated draft");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft no-ops approved drafts without rewriting files or approval metadata", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-idempotent-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });

    const first = await approveLibraryImportDraft(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      actor: "first-operator",
      reason: "first approval wins",
    });

    const relativePath = first.files[0]?.relativePath;
    assert.equal(relativePath, "skills/browser-verification.skill.md");
    const absolutePath = join(libraryRoot, relativePath);
    await writeFile(absolutePath, "local edit that must not be overwritten by an approval retry", "utf8");

    const second = await approveLibraryImportDraft(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      actor: "second-operator",
      reason: "retry should not replace original approval",
    });

    assert.equal(second.status, "approved");
    assert.deepEqual(second.files, first.files);
    assert.deepEqual(second.proposal.objectKeys, first.proposal.objectKeys);
    assert.equal(await readFile(absolutePath, "utf8"), "local edit that must not be overwritten by an approval retry");

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal((resource?.payload as any).approval.actor, "first-operator");
    assert.equal((resource?.payload as any).approval.reason, "first approval wins");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft prevents double approval from overwriting the first approval decision", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-double-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });

    await approveLibraryImportDraft(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      actor: "first-operator",
      reason: "first approval wins",
    });
    await approveLibraryImportDraft(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      actor: "second-operator",
      reason: "second approval must not overwrite metadata",
    });

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(resource?.status, "approved");
    assert.equal((resource?.payload as any).approval.actor, "first-operator");
    assert.equal((resource?.payload as any).approval.reason, "first approval wins");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft marks failed application retryable and later approval can succeed", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-retry-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });
    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    const payload = resource?.payload as any;
    const validContent = payload.proposal.files[0].content;
    payload.proposal.files[0].content = "not a valid southstar library file";
    await db.query(
      "update southstar.runtime_resources set payload_json = $1::jsonb where resource_type = 'library_import_draft' and resource_key = $2",
      [JSON.stringify(payload), draft.draftId],
    );

    await assert.rejects(
      () => approveLibraryImportDraft(db, {
        root: libraryRoot,
        draftId: draft.draftId,
        actor: "first-operator",
        reason: "first attempt hits a sync failure",
      }),
      /library file is invalid/,
    );

    const failed = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(failed?.status, "draft");
    assert.equal((failed?.payload as any).status, "draft");
    assert.match((failed?.payload as any).lastError.message, /library file is invalid/);

    const retryPayload = failed?.payload as any;
    retryPayload.proposal.files[0].content = validContent;
    await db.query(
      "update southstar.runtime_resources set payload_json = $1::jsonb where resource_type = 'library_import_draft' and resource_key = $2",
      [JSON.stringify(retryPayload), draft.draftId],
    );

    const approved = await approveLibraryImportDraft(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      actor: "retry-operator",
      reason: "retry after fixing import content",
    });
    assert.equal(approved.status, "approved");

    const final = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(final?.status, "approved");
    assert.equal((final?.payload as any).approval.actor, "retry-operator");
    assert.equal((final?.payload as any).approval.reason, "retry after fixing import content");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft preflights multi-file proposals before writing or syncing any file", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-preflight-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });
    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    const payload = resource?.payload as any;
    const validFile = payload.proposal.files[0];
    payload.proposal = {
      files: [
        validFile,
        {
          relativePath: "skills/broken.skill.md",
          content: "not a valid southstar library file",
        },
      ],
      objectKeys: ["skill.browser-verification", "skill.broken"],
    };
    await db.query(
      "update southstar.runtime_resources set payload_json = $1::jsonb where resource_type = 'library_import_draft' and resource_key = $2",
      [JSON.stringify(payload), draft.draftId],
    );

    await assert.rejects(
      () => approveLibraryImportDraft(db, {
        root: libraryRoot,
        draftId: draft.draftId,
        actor: "operator",
        reason: "invalid second file should block all side effects",
      }),
      /library file is invalid/,
    );

    assert.deepEqual(await listLibraryFiles({ root: libraryRoot }), []);
    assert.equal(await findLibraryObjectByKey(db, "skill.browser-verification"), null);

    const failed = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(failed?.status, "draft");
    assert.match((failed?.payload as any).lastError.message, /library file is invalid/);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft preflights unsupported reference prefixes before writing or syncing any file", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-ref-preflight-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });
    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    const payload = resource?.payload as any;
    const validFile = payload.proposal.files[0];
    payload.proposal = {
      files: [
        validFile,
        {
          relativePath: "skills/broken-ref.skill.md",
          content: `---
schemaVersion: southstar.library.skill_spec_file.v1
id: skill.broken-ref
title: Broken Ref
scope: software
status: draft
requiresToolRefs:
  - browser
---

# Instructions

Bad reference prefix.
`,
        },
      ],
      objectKeys: ["skill.browser-verification", "skill.broken-ref"],
    };
    await db.query(
      "update southstar.runtime_resources set payload_json = $1::jsonb where resource_type = 'library_import_draft' and resource_key = $2",
      [JSON.stringify(payload), draft.draftId],
    );

    await assert.rejects(
      () => approveLibraryImportDraft(db, {
        root: libraryRoot,
        draftId: draft.draftId,
        actor: "operator",
        reason: "unsupported ref should block all side effects",
      }),
      /unsupported referenced object key prefix: browser/,
    );

    assert.deepEqual(await listLibraryFiles({ root: libraryRoot }), []);
    assert.equal(await findLibraryObjectByKey(db, "skill.browser-verification"), null);

    const failed = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(failed?.status, "draft");
    assert.match((failed?.payload as any).lastError.message, /unsupported referenced object key prefix: browser/);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft rejects existing files before overwriting library content", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-file-conflict-"));

  try {
    await mkdir(join(libraryRoot, "skills"), { recursive: true });
    await writeFile(join(libraryRoot, "skills/browser-verification.skill.md"), "existing library truth", { encoding: "utf8", flag: "wx" });
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });

    await assert.rejects(
      () => approveLibraryImportDraft(db, {
        root: libraryRoot,
        draftId: draft.draftId,
        actor: "operator",
        reason: "must not overwrite existing files",
      }),
      /library import file already exists: skills\/browser-verification\.skill\.md/,
    );

    assert.equal(await readFile(join(libraryRoot, "skills/browser-verification.skill.md"), "utf8"), "existing library truth");
    assert.equal(await findLibraryObjectByKey(db, "skill.browser-verification"), null);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft rejects existing graph objects before downgrading library truth", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-object-conflict-"));

  try {
    await upsertLibraryObject(db, {
      objectKey: "skill.browser-verification",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.browser-verification@approved",
      state: { title: "Approved Browser Verification", scope: "software" },
    });
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });

    await assert.rejects(
      () => approveLibraryImportDraft(db, {
        root: libraryRoot,
        draftId: draft.draftId,
        actor: "operator",
        reason: "must not overwrite approved graph object",
      }),
      /library import object already exists: skill\.browser-verification/,
    );

    assert.deepEqual(await listLibraryFiles({ root: libraryRoot }), []);
    assert.equal((await findLibraryObjectByKey(db, "skill.browser-verification"))?.status, "approved");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft cleans written files when graph transaction sees a late object conflict", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-late-conflict-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });
    let txCount = 0;
    const racingDb = {
      ...db,
      tx: async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => {
        txCount += 1;
        if (txCount === 2) {
          await upsertLibraryObject(db, {
            objectKey: "skill.browser-verification",
            objectKind: "skill_spec",
            status: "approved",
            headVersionId: "skill.browser-verification@racing-actor",
            state: { title: "Racing Browser Verification", scope: "software" },
          });
        }
        return await db.tx(fn);
      },
    };

    await assert.rejects(
      () => approveLibraryImportDraft(racingDb, {
        root: libraryRoot,
        draftId: draft.draftId,
        actor: "operator",
        reason: "late graph conflict should rollback file side effects",
      }),
      /library object already exists: skill\.browser-verification/,
    );

    assert.deepEqual(await listLibraryFiles({ root: libraryRoot }), []);
    assert.equal((await findLibraryObjectByKey(db, "skill.browser-verification"))?.status, "approved");

    const failed = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(failed?.status, "draft");
    assert.match((failed?.payload as any).lastError.message, /library object already exists/);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft rejects active applying approvals without side effects", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-active-lease-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });
    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    const payload = resource?.payload as any;
    await db.query(
      `update southstar.runtime_resources
          set status = 'applying',
              payload_json = $1::jsonb
        where resource_type = 'library_import_draft' and resource_key = $2`,
      [JSON.stringify({
        ...payload,
        status: "applying",
        approval: {
          actor: "first-operator",
          reason: "first request is still applying",
          approvedAt: "2026-07-03T00:00:00.000Z",
        },
        approvalLease: {
          attemptId: "active-attempt",
          startedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }), draft.draftId],
    );

    await assert.rejects(
      () => approveLibraryImportDraft(db, {
        root: libraryRoot,
        draftId: draft.draftId,
        actor: "second-operator",
        reason: "must not overlap active apply",
      }),
      /library import draft is already applying/,
    );

    assert.deepEqual(await listLibraryFiles({ root: libraryRoot }), []);
    assert.equal(await findLibraryObjectByKey(db, "skill.browser-verification"), null);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approveLibraryImportDraft resumes applying drafts and preserves in-flight approval metadata", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-applying-"));

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "browser skill prompt",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
    });
    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    const payload = resource?.payload as any;
    const firstApproval = {
      actor: "first-operator",
      reason: "first request is already applying",
      approvedAt: "2026-07-03T00:00:00.000Z",
    };
    await db.query(
      `update southstar.runtime_resources
          set status = 'applying',
              payload_json = $1::jsonb
        where resource_type = 'library_import_draft' and resource_key = $2`,
      [JSON.stringify({
        ...payload,
        status: "applying",
        approval: firstApproval,
        approvalLease: {
          attemptId: "expired-attempt",
          startedAt: "2000-01-01T00:00:00.000Z",
          expiresAt: "2000-01-01T00:01:00.000Z",
        },
        applied: {
          files: [{ relativePath: "skills/browser-verification.skill.md" }],
          objectKeys: ["skill.browser-verification"],
        },
      }), draft.draftId],
    );

    const approved = await approveLibraryImportDraft(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      actor: "second-operator",
      reason: "concurrent retry should not overwrite in-flight approval",
    });

    assert.equal(approved.status, "approved");
    const final = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(final?.status, "approved");
    assert.deepEqual((final?.payload as any).approval, firstApproval);
    assert.equal((final?.payload as any).applied.files[0].relativePath, "skills/browser-verification.skill.md");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("POST /api/v2/library/import-drafts creates a draft from a canonical paste source", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-route-"));

  try {
    const response = await handleRuntimeRoute({ db, libraryRoot } as any, new Request("http://local/api/v2/library/import-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          kind: "paste",
          label: "browser skill prompt",
          content: "create a browser verification skill that uses tool.browser",
        },
        scope: "software",
      }),
    }));

    assert.equal(response.status, 200);
    const envelope = await response.json() as any;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.kind, "library-import-draft");
    assert.match(envelope.result.draftId, /^library-import-draft-/);
    assert.equal(envelope.result.status, "draft");
    assert.equal(envelope.result.proposal.files[0]?.relativePath, "skills/browser-verification.skill.md");
    assert.deepEqual(await listLibraryFiles({ root: libraryRoot }), []);

    const resource = await getResourceByKeyPg(db, "library_import_draft", envelope.result.draftId);
    assert.equal((resource?.payload as any).source.kind, "paste");
    assert.equal((resource?.payload as any).source.label, "browser skill prompt");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("POST /api/v2/library/import-drafts forwards configured import analysis providers for github sources", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-route-github-"));
  const libraryImportSourceFetcher: LibraryImportSourceFetcher = async () => [
    {
      path: "agents/reviewer.agent.md",
      label: "Reviewer",
      content: "# Reviewer\nUses the review skill.",
    },
    {
      path: "skills/review.skill.md",
      label: "Review",
      content: "# Review Skill\nReview changes.",
    },
  ];
  const libraryImportLlmProvider: LibraryImportLlmProvider = async () => ({
    candidates: [
      {
        objectKey: "agent.reviewer",
        kind: "agent",
        title: "Reviewer",
        sourcePath: "agents/reviewer.agent.md",
        selectedByDefault: true,
        confidence: 0.9,
      },
      {
        objectKey: "skill.review",
        kind: "skill",
        title: "Review",
        sourcePath: "skills/review.skill.md",
        selectedByDefault: true,
        confidence: 0.8,
      },
    ],
    proposedEdges: [
      { fromObjectKey: "agent.reviewer", edgeType: "uses", toObjectKey: "skill.review", confidence: 0.95 },
    ],
  });

  try {
    const response = await handleRuntimeRoute({
      db,
      libraryRoot,
      libraryImportSourceFetcher,
      libraryImportLlmProvider,
    } as any, new Request("http://local/api/v2/library/import-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { kind: "github", repoUrl: "https://github.com/acme/library" },
        scope: "software",
      }),
    }));

    assert.equal(response.status, 200);
    const envelope = await response.json() as any;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.kind, "library-import-draft");
    assert.deepEqual(envelope.result.documents.map((doc: any) => doc.path), [
      "agents/reviewer.agent.md",
      "skills/review.skill.md",
    ]);
    assert.deepEqual(envelope.result.candidates.map((candidate: any) => candidate.objectKey), [
      "agent.reviewer",
      "skill.review",
    ]);
    assert.deepEqual(envelope.result.proposedEdges, [
      {
        fromObjectKey: "agent.reviewer",
        edgeType: "uses",
        toObjectKey: "skill.review",
        confidence: 0.95,
      },
    ]);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("POST /api/v2/library/import-drafts/:draftId/approve approves and writes synced files", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-route-approve-"));

  try {
    const context = { db, libraryRoot } as any;
    const draftResponse = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/import-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          kind: "paste",
          label: "browser skill prompt",
          content: "create a browser verification skill that uses tool.browser",
        },
        scope: "software",
      }),
    }));
    const draftEnvelope = await draftResponse.json() as any;

    const approveResponse = await handleRuntimeRoute(context, new Request(`http://local/api/v2/library/import-drafts/${draftEnvelope.result.draftId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "operator", reason: "looks good" }),
    }));

    assert.equal(approveResponse.status, 200);
    const approveEnvelope = await approveResponse.json() as any;
    assert.equal(approveEnvelope.ok, true);
    assert.equal(approveEnvelope.kind, "library-import-draft-approval");
    assert.equal(approveEnvelope.result.status, "approved");
    assert.equal(approveEnvelope.result.files[0]?.relativePath, "skills/browser-verification.skill.md");

    const content = await readFile(join(libraryRoot, "skills/browser-verification.skill.md"), "utf8");
    assert.match(content, /id: skill\.browser-verification/);
    assert.equal((await findLibraryObjectByKey(db, "skill.browser-verification"))?.objectKind, "skill_spec");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("approving an invalid or missing library import draft fails clearly", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-missing-"));

  try {
    await assert.rejects(
      () => approveLibraryImportDraft(db, {
        root: libraryRoot,
        draftId: "library-import-draft-missing",
        actor: "operator",
        reason: "try missing",
      }),
      /library import draft not found: library-import-draft-missing/,
    );

    const response = await handleRuntimeRoute({ db, libraryRoot } as any, new Request("http://local/api/v2/library/import-drafts/library-import-draft-missing/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "operator", reason: "try missing" }),
    }));

    assert.equal(response.status, 400);
    const envelope = await response.json() as any;
    assert.equal(envelope.ok, false);
    assert.match(envelope.error, /library import draft not found: library-import-draft-missing/);

    const malformed = await handleRuntimeRoute({ db, libraryRoot } as any, new Request("http://local/api/v2/library/import-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { kind: "paste", url: "https://example.com/not-content" } }),
    }));
    assert.equal(malformed.status, 400);
    const malformedEnvelope = await malformed.json() as any;
    assert.match(malformedEnvelope.error, /source.content is required/);

    assert.throws(
      () => asImportSource({ kind: "subversion", url: "https://example.com/project" }),
      /unsupported import source kind: subversion/,
    );
    assert.throws(
      () => asImportSource({ kind: "github", repository: "acme/library" }),
      /source.repoUrl is required/,
    );

    await upsertRuntimeResourcePg(db, {
      resourceType: "library_import_draft",
      resourceKey: "library-import-draft-invalid",
      scope: "library",
      status: "draft",
      payload: {
        schemaVersion: "southstar.library.import_draft.v1",
        draftId: "library-import-draft-invalid",
        proposal: { files: [], objectKeys: [] },
      },
    });
    await assert.rejects(
      () => approveLibraryImportDraft(db, {
        root: libraryRoot,
        draftId: "library-import-draft-invalid",
        actor: "operator",
        reason: "try invalid",
      }),
      /library import draft has no files to approve/,
    );
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
