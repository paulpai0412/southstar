import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listLibraryFiles } from "../../src/v2/design-library/files/library-file-store.ts";
import {
  approveLibraryImportDraft,
  createLibraryImportDraft,
  installLibraryImportCandidates,
} from "../../src/v2/design-library/importers/library-import-draft-store.ts";
import { asImportSource, extractLibraryImportProposal } from "../../src/v2/design-library/importers/library-import-extractor.ts";
import { extractLibraryCandidatesFromDocuments } from "../../src/v2/design-library/importers/library-candidate-extractor.ts";
import {
  analyzeLibraryImportWithLlm,
  analyzeLibraryImportOntologyWithLlm,
  buildLibraryImportAnalysisPrompt,
  buildLibraryImportCandidatePrompt,
  type LibraryImportOntologyExistingGraphNode,
  type LibraryImportLlmProvider,
} from "../../src/v2/design-library/importers/library-llm-import-analyzer.ts";
import { CATALOG_CANONICAL_DOMAINS } from "../../src/v2/design-library/canonical-domains.ts";
import type { LibraryImportSourceFetcher } from "../../src/v2/design-library/importers/library-source-fetcher.ts";
import { parseLibraryFileContent } from "../../src/v2/design-library/files/library-file-parser.ts";
import {
  findLibraryEdgesFrom,
  findLibraryObjectByKey,
  upsertLibraryObject,
} from "../../src/v2/design-library/library-graph-store.ts";
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

test("buildLibraryImportAnalysisPrompt includes bounded document content excerpts for LLM classification", () => {
  const prompt = buildLibraryImportAnalysisPrompt([
    {
      path: "engineering/engineering-frontend-developer.md",
      label: "engineering-frontend-developer",
      content: "# Frontend Developer\nBuilds production React UI and reviews accessibility.",
    },
  ], "software");

  assert.match(prompt, /engineering\/engineering-frontend-developer\.md/);
  assert.match(prompt, /# Frontend Developer/);
  assert.match(prompt, /Builds production React UI/);
  assert.match(prompt, /Return exactly one JSON object/);
  assert.match(prompt, /Use this shape: \{"candidates":/);
});

test("library import candidate prompt constrains LLM domain classification to catalog departments", () => {
  const prompt = buildLibraryImportCandidatePrompt([
    {
      path: "marketing/marketing-seo-specialist.md",
      label: "marketing-seo-specialist",
      content: "# SEO专家\nOptimizes search visibility.",
    },
  ], "software", {
    sourceRepoPath: "/tmp/agency-agents-zh",
  });

  assert.match(prompt, /CanonicalDomainTaxonomy/);
  assert.match(prompt, /"engineering"/);
  assert.match(prompt, /"marketing"/);
  assert.match(prompt, /"security"/);
  assert.match(prompt, /domain.*canonical domain key/i);
  assert.match(prompt, /classificationReason/);
  assert.match(prompt, /skills\/<slug>\/SKILL\.md/);
  assert.match(prompt, /skill\.<slug>/);
  assert.equal(CATALOG_CANONICAL_DOMAINS.length, 19);
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

test("extractLibraryCandidatesFromDocuments derives skill slugs from parent folders for SKILL.md files", () => {
  const result = extractLibraryCandidatesFromDocuments({
    scope: "software",
    documents: [
      { path: "skills/brainstorming/SKILL.md", label: "SKILL", content: "# Brainstorming" },
      { path: "skills/verification-before-completion/SKILL.md", label: "SKILL", content: "# Verification Before Completion" },
    ],
  });

  assert.deepEqual(result.candidates.map((candidate) => ({
    objectKey: candidate.objectKey,
    title: candidate.title,
    sourcePath: candidate.sourcePath,
  })), [
    {
      objectKey: "skill.brainstorming",
      title: "Brainstorming",
      sourcePath: "skills/brainstorming/SKILL.md",
    },
    {
      objectKey: "skill.verification-before-completion",
      title: "Verification Before Completion",
      sourcePath: "skills/verification-before-completion/SKILL.md",
    },
  ]);
});

test("analyzeLibraryImportWithLlm prompts for candidate classification and normalizes provider output", async () => {
  const prompts: string[] = [];
  const provider: LibraryImportLlmProvider = async (input) => {
    prompts.push(input.prompt);
    return {
      candidates: [
        { objectKey: "agent.reviewer", kind: "agent", title: "Reviewer", selectedByDefault: true, confidence: 0.8 },
        { objectKey: "skill.review", kind: "skill", title: "Review", selectedByDefault: true, confidence: -0.5 },
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
  assert.doesNotMatch(prompts[0] ?? "", /ontology edges/i);
  assert.equal(result.candidates[0]?.confidence, 0.8);
  assert.equal(result.candidates[1]?.confidence, 0);
  assert.deepEqual(result.proposedEdges, []);
});

test("analyzeLibraryImportWithLlm drops candidates with untrusted source paths", async () => {
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

  assert.deepEqual(result.candidates.map((candidate) => candidate.objectKey), [
    "agent.reviewer",
    "skill.review",
    "skill.audit",
    "tool.github",
  ]);
  assert.deepEqual(result.proposedEdges, []);
});

test("analyzeLibraryImportWithLlm canonicalizes folder-prefixed object keys from source paths", async () => {
  const provider: LibraryImportLlmProvider = async () => ({
    candidates: [
      {
        objectKey: "agent.academic.academic-anthropologist",
        kind: "agent",
        title: "人类学家",
        sourcePath: "academic/academic-anthropologist.md",
      },
      {
        objectKey: "agent.supply-chain.supply-chain-route-optimizer",
        kind: "agent",
        title: "物流路线优化师",
        sourcePath: "supply-chain/supply-chain-route-optimizer.md",
      },
      {
        objectKey: "agency-agents-zh.engineering.engineering-frontend-developer",
        kind: "agent",
        title: "前端开发者",
        sourcePath: "engineering/engineering-frontend-developer.md",
      },
      {
        objectKey: "agent.game-development.blender.blender-addon-engineer",
        kind: "agent",
        title: "Blender 插件工程师",
        sourcePath: "game-development/blender/blender-addon-engineer.md",
      },
    ],
  });

  const result = await analyzeLibraryImportWithLlm({
    scope: "software",
    documents: [],
    sourceRepoPath: "/tmp/agency-agents-zh",
    llmProvider: provider,
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.objectKey), [
    "agent.academic-anthropologist",
    "agent.supply-chain-route-optimizer",
    "agent.engineering-frontend-developer",
    "agent.blender-addon-engineer",
  ]);
});

test("analyzeLibraryImportWithLlm canonicalizes SKILL.md candidates from parent folders", async () => {
  const provider: LibraryImportLlmProvider = async () => ({
    candidates: [
      {
        objectKey: "skill.skill",
        kind: "skill",
        title: "SKILL",
        sourcePath: "skills/brainstorming/SKILL.md",
      },
      {
        objectKey: "skill.skill",
        kind: "skill",
        title: "SKILL",
        sourcePath: "skills/verification-before-completion/SKILL.md",
      },
    ],
  });

  const result = await analyzeLibraryImportWithLlm({
    scope: "software",
    documents: [
      { path: "skills/brainstorming/SKILL.md", label: "SKILL", content: "# Brainstorming" },
      { path: "skills/verification-before-completion/SKILL.md", label: "SKILL", content: "# Verification Before Completion" },
    ],
    llmProvider: provider,
  });

  assert.deepEqual(result.candidates.map((candidate) => ({
    objectKey: candidate.objectKey,
    title: candidate.title,
    sourcePath: candidate.sourcePath,
  })), [
    {
      objectKey: "skill.brainstorming",
      title: "Brainstorming",
      sourcePath: "skills/brainstorming/SKILL.md",
    },
    {
      objectKey: "skill.verification-before-completion",
      title: "Verification Before Completion",
      sourcePath: "skills/verification-before-completion/SKILL.md",
    },
  ]);
});

test("analyzeLibraryImportWithLlm maps candidates to canonical catalog domains from source path or LLM domain", async () => {
  const provider: LibraryImportLlmProvider = async () => ({
    candidates: [
      {
        objectKey: "agent.marketing-seo-specialist",
        kind: "agent",
        title: "SEO专家",
        domain: "engineering",
        sourcePath: "marketing/marketing-seo-specialist.md",
        classificationReason: "Path belongs to marketing department.",
      },
      {
        objectKey: "skill.security-audit",
        kind: "skill",
        title: "Security Audit",
        domain: "security",
        sourcePath: "skills/security-audit/SKILL.md",
        classificationReason: "Skill audits security findings.",
      },
      {
        objectKey: "tool.freeform",
        kind: "tool",
        title: "Freeform",
        domain: "software",
        classificationReason: "Invalid domain should not be accepted.",
      },
    ],
  });

  const result = await analyzeLibraryImportWithLlm({
    scope: "software",
    documents: [
      { path: "marketing/marketing-seo-specialist.md", label: "SEO专家", content: "# SEO专家" },
      { path: "skills/security-audit/SKILL.md", label: "Security Audit", content: "# Security Audit" },
    ],
    llmProvider: provider,
  });

  assert.deepEqual(result.candidates.map((candidate) => ({
    objectKey: candidate.objectKey,
    scope: candidate.scope,
    domain: candidate.domain,
    classificationReason: candidate.classificationReason,
  })), [
    {
      objectKey: "agent.marketing-seo-specialist",
      scope: "marketing",
      domain: "marketing",
      classificationReason: "Path belongs to marketing department.",
    },
    {
      objectKey: "skill.security-audit",
      scope: "security",
      domain: "security",
      classificationReason: "Skill audits security findings.",
    },
  ]);
});

test("analyzeLibraryImportOntologyWithLlm accepts full ontology edge vocabulary for selected candidates", async () => {
  const prompts: string[] = [];
  const provider: LibraryImportLlmProvider = async (input) => {
    prompts.push(input.prompt);
    return {
      proposedEdges: [
        { fromObjectKey: "agent.reviewer", edgeType: "uses", toObjectKey: "skill.review", confidence: 0.9 },
        { fromObjectKey: "agent.reviewer", edgeType: "has_capability", toObjectKey: "skill.review", confidence: 0.86 },
        { fromObjectKey: "skill.review", edgeType: "provides", toObjectKey: "tool.github", confidence: 0.81 },
        { fromObjectKey: "skill.review", edgeType: "produces", toObjectKey: "skill.audit", confidence: 0.74 },
        { fromObjectKey: "skill.audit", edgeType: "consumes", toObjectKey: "skill.review", confidence: 0.7 },
        { fromObjectKey: "skill.review", edgeType: "validates", toObjectKey: "skill.audit", confidence: 0.76 },
        { fromObjectKey: "skill.review", edgeType: "precedes", toObjectKey: "skill.audit", confidence: 0.8 },
        { fromObjectKey: "skill.review", edgeType: "unblocks", toObjectKey: "skill.audit", confidence: 0.79 },
        { fromObjectKey: "skill.review", edgeType: "substitutes", toObjectKey: "skill.audit", confidence: 0.63 },
        { fromObjectKey: "skill.review", edgeType: "complements", toObjectKey: "tool.github", confidence: 0.77 },
        { fromObjectKey: "skill.review", edgeType: "incompatible_with", toObjectKey: "tool.github", confidence: 0.52 },
        { fromObjectKey: "tool.github", edgeType: "requires_approval", toObjectKey: "skill.review", confidence: 0.66 },
        { fromObjectKey: "tool.github", edgeType: "requires_secret", toObjectKey: "skill.review", confidence: 0.67 },
        { fromObjectKey: "tool.github", edgeType: "requires_secret_group", toObjectKey: "skill.review", confidence: 0.68 },
        { fromObjectKey: "skill.review", edgeType: "conflicts_with", toObjectKey: "tool.github", confidence: 0.7 },
        { fromObjectKey: "skill.review", edgeType: "workflow_precedes", toObjectKey: "skill.audit", confidence: 0.8 },
        { fromObjectKey: "skill.review", edgeType: "similar_to", toObjectKey: "skill.audit", confidence: 0.6 },
        { fromObjectKey: "skill.review", edgeType: "contains", toObjectKey: "skill.audit", confidence: 1 },
        { fromObjectKey: "skill.review", edgeType: "similar_to", toObjectKey: "skill.unselected", confidence: 1 },
      ],
    };
  };

  const edges = await analyzeLibraryImportOntologyWithLlm({
    scope: "software",
    candidates: [
      { objectKey: "agent.reviewer", kind: "agent", title: "Reviewer", scope: "software", selectedByDefault: true },
      { objectKey: "skill.review", kind: "skill", title: "Review", scope: "software", selectedByDefault: true },
      { objectKey: "skill.audit", kind: "skill", title: "Audit", scope: "software", selectedByDefault: true },
      { objectKey: "tool.github", kind: "tool", title: "GitHub", scope: "software", selectedByDefault: true },
    ],
    llmProvider: provider,
  });

  assert.match(prompts[0] ?? "", /conflicts_with/);
  assert.match(prompts[0] ?? "", /workflow_precedes/);
  assert.match(prompts[0] ?? "", /produces/);
  assert.match(prompts[0] ?? "", /requires_secret/);
  assert.match(prompts[0] ?? "", /requires_secret_group/);
  assert.match(prompts[0] ?? "", /similar_to/);
  assert.deepEqual(edges.map((edge) => ({
    fromObjectKey: edge.fromObjectKey,
    edgeType: edge.edgeType,
    toObjectKey: edge.toObjectKey,
  })), [
    { fromObjectKey: "agent.reviewer", edgeType: "uses", toObjectKey: "skill.review" },
    { fromObjectKey: "agent.reviewer", edgeType: "has_capability", toObjectKey: "skill.review" },
    { fromObjectKey: "skill.review", edgeType: "provides", toObjectKey: "tool.github" },
    { fromObjectKey: "skill.review", edgeType: "produces", toObjectKey: "skill.audit" },
    { fromObjectKey: "skill.audit", edgeType: "consumes", toObjectKey: "skill.review" },
    { fromObjectKey: "skill.review", edgeType: "validates", toObjectKey: "skill.audit" },
    { fromObjectKey: "skill.review", edgeType: "precedes", toObjectKey: "skill.audit" },
    { fromObjectKey: "skill.review", edgeType: "unblocks", toObjectKey: "skill.audit" },
    { fromObjectKey: "skill.review", edgeType: "substitutes", toObjectKey: "skill.audit" },
    { fromObjectKey: "skill.review", edgeType: "complements", toObjectKey: "tool.github" },
    { fromObjectKey: "skill.review", edgeType: "incompatible_with", toObjectKey: "tool.github" },
    { fromObjectKey: "tool.github", edgeType: "requires_approval", toObjectKey: "skill.review" },
    { fromObjectKey: "tool.github", edgeType: "requires_secret", toObjectKey: "skill.review" },
    { fromObjectKey: "tool.github", edgeType: "requires_secret_group", toObjectKey: "skill.review" },
    { fromObjectKey: "skill.review", edgeType: "conflicts_with", toObjectKey: "tool.github" },
    { fromObjectKey: "skill.review", edgeType: "workflow_precedes", toObjectKey: "skill.audit" },
    { fromObjectKey: "skill.review", edgeType: "similar_to", toObjectKey: "skill.audit" },
  ]);
});

test("analyzeLibraryImportOntologyWithLlm can link selected candidates to existing approved graph nodes", async () => {
  const prompts: string[] = [];
  const provider: LibraryImportLlmProvider = async (input) => {
    prompts.push(input.prompt);
    return {
      candidates: [
        {
          objectKey: "skill.beautiful-article",
          kind: "skill",
          title: "Beautiful Article",
          selectedByDefault: true,
          confidence: 0.95,
        },
      ],
      proposedEdges: [
        {
          fromObjectKey: "agent.article-editor",
          edgeType: "uses",
          toObjectKey: "skill.beautiful-article",
          confidence: 0.91,
          rationale: "Article editor agents can use the imported article skill.",
        },
        {
          fromObjectKey: "agent.draft-only",
          edgeType: "uses",
          toObjectKey: "skill.beautiful-article",
          confidence: 0.99,
          rationale: "Draft-only existing nodes are not in the approved graph packet.",
        },
        {
          fromObjectKey: "agent.article-editor",
          edgeType: "similar_to",
          toObjectKey: "agent.content-strategist",
          confidence: 0.8,
          rationale: "Both endpoints are existing nodes, so import linking should reject it.",
        },
      ],
    };
  };

  const existingGraphNodes: LibraryImportOntologyExistingGraphNode[] = [
    {
      objectKey: "agent.article-editor",
      objectKind: "agent_definition",
      status: "approved",
      title: "Article Editor",
      scope: "design",
      headVersionId: "agent.article-editor@1",
    },
    {
      objectKey: "agent.content-strategist",
      objectKind: "agent_definition",
      status: "approved",
      title: "Content Strategist",
      scope: "design",
      headVersionId: "agent.content-strategist@1",
    },
  ];

  const edges = await analyzeLibraryImportOntologyWithLlm({
    scope: "design",
    candidates: [
      {
        objectKey: "skill.beautiful-article",
        kind: "skill",
        title: "Beautiful Article",
        scope: "design",
        selectedByDefault: true,
      },
    ],
    existingGraph: {
      nodes: existingGraphNodes,
      edges: [],
    },
    llmProvider: provider,
  });

  assert.match(prompts[0] ?? "", /ExistingApprovedGraphNodes/);
  assert.match(prompts[0] ?? "", /agent\.article-editor/);
  assert.match(prompts[0] ?? "", /At least one endpoint must be one of the selected candidates/);
  assert.deepEqual(edges.map((edge) => ({
    fromObjectKey: edge.fromObjectKey,
    edgeType: edge.edgeType,
    toObjectKey: edge.toObjectKey,
  })), [
    {
      fromObjectKey: "agent.article-editor",
      edgeType: "uses",
      toObjectKey: "skill.beautiful-article",
    },
  ]);
});

test("analyzeLibraryImportWithLlm requires an LLM provider instead of falling back to deterministic parsing", async () => {
  await assert.rejects(
    () => analyzeLibraryImportWithLlm({
      scope: "software",
      documents: [
        { path: "engineering/engineering-frontend-developer.md", label: "engineering-frontend-developer", content: "# Frontend Developer Agent" },
      ],
    }),
    /library import analysis requires an LLM provider/,
  );
});

test("createLibraryImportDraft requires LLM analysis for github repository imports", async () => {
  const db = await createTestPostgresDb();
  const sourceFetcher: LibraryImportSourceFetcher = async () => [
    {
      path: "engineering/engineering-frontend-developer.md",
      label: "engineering-frontend-developer",
      content: "---\nname: Frontend Developer\n---\n# Frontend Developer Agent",
    },
  ];

  try {
    await assert.rejects(
      () => createLibraryImportDraft(db, {
        source: { kind: "github", repoUrl: "https://github.com/jnMetaCode/agency-agents-zh" },
        scope: "software",
        sourceFetcher,
      }),
      /library import analysis requires an LLM provider/,
    );
  } finally {
    await db.close();
  }
});

test("createLibraryImportDraft preserves the legacy proposal and persists analyzed documents and candidates without ontology edges", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-analysis-"));
  const provider: LibraryImportLlmProvider = async () => ({
    candidates: [
      { objectKey: "agent.browser-reviewer", kind: "agent", title: "Browser Reviewer", selectedByDefault: true, confidence: 0.9 },
      { objectKey: "skill.browser-verification", kind: "skill", title: "Browser Verification", selectedByDefault: true, confidence: 0.9 },
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
    assert.deepEqual(draft.proposedEdges, []);
    assert.deepEqual(await listLibraryFiles({ root: libraryRoot }), []);

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.deepEqual((resource?.payload as any).proposal.objectKeys, ["skill.browser-verification"]);
    assert.deepEqual((resource?.payload as any).documents.map((doc: any) => doc.path), ["browser-skill-prompt.md"]);
    assert.deepEqual((resource?.payload as any).candidates.map((candidate: any) => candidate.objectKey), [
      "agent.browser-reviewer",
      "skill.browser-verification",
    ]);
    assert.deepEqual((resource?.payload as any).proposedEdges, []);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("installLibraryImportCandidates writes selected candidates, syncs graph objects, and persists ontology edges", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-candidate-install-"));
  const provider: LibraryImportLlmProvider = async () => ({
    candidates: [
      { objectKey: "agent.reviewer", kind: "agent", title: "Reviewer", selectedByDefault: true, confidence: 0.92 },
      { objectKey: "skill.review", kind: "skill", title: "Review", selectedByDefault: true, confidence: 0.88 },
      { objectKey: "tool.github", kind: "tool", title: "GitHub", selectedByDefault: true, confidence: 0.81 },
      { objectKey: "mcp.filesystem", kind: "mcp", title: "Filesystem", selectedByDefault: false, confidence: 0.5 },
    ],
    proposedEdges: [
      {
        fromObjectKey: "agent.reviewer",
        edgeType: "uses",
        toObjectKey: "skill.review",
        confidence: 0.91,
        rationale: "Reviewer delegates review work to the review skill.",
      },
      {
        fromObjectKey: "skill.review",
        edgeType: "requires",
        toObjectKey: "tool.github",
        confidence: 0.83,
        rationale: "Review skill needs GitHub access.",
      },
      {
        fromObjectKey: "skill.review",
        edgeType: "requires",
        toObjectKey: "mcp.filesystem",
        confidence: 0.7,
        rationale: "Unselected endpoint should filter this edge.",
      },
    ],
  });

  try {
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "review library docs",
        content: "reviewer agent uses a review skill and github tool",
      },
      scope: "software",
      llmProvider: provider,
    });

    const installed = await installLibraryImportCandidates(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      selectedCandidateIds: ["agent.reviewer", "skill.review", "tool.github"],
      actor: "operator",
      reason: "selected reviewed candidates",
      llmProvider: provider,
    });

    assert.equal(installed.draftId, draft.draftId);
    assert.equal(installed.status, "installed");
    assert.deepEqual(
      installed.installedObjects.map((object) => object.objectKey),
      ["agent.reviewer", "skill.review", "tool.github"],
    );
    assert.deepEqual(
      installed.installedObjects.map((object) => object.relativePath),
      ["agents/reviewer.agent.md", "skills/review.skill.md", "tools/github.tool.yaml"],
    );
    assert.deepEqual(
      installed.installedObjects.map((object) => object.object.status),
      ["approved", "approved", "approved"],
    );
    assert.deepEqual(
      installed.installedEdges.map((edge) => ({
        fromObjectKey: edge.fromObjectKey,
        edgeType: edge.edgeType,
        toObjectKey: edge.toObjectKey,
        confidence: edge.metadata.confidence,
        rationale: edge.metadata.rationale,
        source: edge.metadata.source,
        draftId: edge.metadata.draftId,
      })),
      [
        {
          fromObjectKey: "agent.reviewer",
          edgeType: "uses",
          toObjectKey: "skill.review",
          confidence: 0.91,
          rationale: "Reviewer delegates review work to the review skill.",
          source: "library-import-ontology",
          draftId: draft.draftId,
        },
        {
          fromObjectKey: "skill.review",
          edgeType: "requires",
          toObjectKey: "tool.github",
          confidence: 0.83,
          rationale: "Review skill needs GitHub access.",
          source: "library-import-ontology",
          draftId: draft.draftId,
        },
      ],
    );

    for (const relativePath of ["agents/reviewer.agent.md", "skills/review.skill.md", "tools/github.tool.yaml"]) {
      const content = await readFile(join(libraryRoot, relativePath), "utf8");
      const parsed = parseLibraryFileContent({ path: `library/${relativePath}`, content });
      assert.equal(parsed.ok, true, `${relativePath} should parse`);
      if (parsed.ok) assert.equal(parsed.file.status, "approved", `${relativePath} should install as approved`);
    }

    assert.deepEqual(
      {
        agentKind: (await findLibraryObjectByKey(db, "agent.reviewer"))?.objectKind,
        agentStatus: (await findLibraryObjectByKey(db, "agent.reviewer"))?.status,
        skillKind: (await findLibraryObjectByKey(db, "skill.review"))?.objectKind,
        skillStatus: (await findLibraryObjectByKey(db, "skill.review"))?.status,
        toolKind: (await findLibraryObjectByKey(db, "tool.github"))?.objectKind,
        toolStatus: (await findLibraryObjectByKey(db, "tool.github"))?.status,
      },
      {
        agentKind: "agent_definition",
        agentStatus: "approved",
        skillKind: "skill_spec",
        skillStatus: "approved",
        toolKind: "tool_definition",
        toolStatus: "approved",
      },
    );
    assert.equal(await findLibraryObjectByKey(db, "mcp.filesystem"), null);

    const agentEdges = await findLibraryEdgesFrom(db, "agent.reviewer", "uses", { scope: "software" });
    assert.equal(agentEdges.length, 1);
    assert.equal(agentEdges[0]?.metadata.source, "library-import-ontology");
    assert.equal(agentEdges[0]?.metadata.draftId, draft.draftId);
    assert.equal(agentEdges[0]?.metadata.confidence, 0.91);
    assert.equal(agentEdges[0]?.metadata.rationale, "Reviewer delegates review work to the review skill.");
    const skillEdges = await findLibraryEdgesFrom(db, "skill.review", "requires", { scope: "software" });
    assert.deepEqual(skillEdges.map((edge) => edge.toObjectKey), ["tool.github"]);

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(resource?.status, "installed");
    assert.equal((resource?.payload as any).status, "installed");
    assert.equal((resource?.payload as any).install.actor, "operator");
    assert.equal((resource?.payload as any).install.reason, "selected reviewed candidates");
    assert.deepEqual((resource?.payload as any).install.installedObjectKeys, [
      "agent.reviewer",
      "skill.review",
      "tool.github",
    ]);
    assert.deepEqual((resource?.payload as any).install.installedEdges.map((edge: any) => edge.edgeType), [
      "uses",
      "requires",
    ]);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("installLibraryImportCandidates links selected imports to existing approved graph nodes", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-existing-graph-"));
  const prompts: string[] = [];
  const progressEvents: Array<{ event: string; data: Record<string, unknown> }> = [];

  const provider: LibraryImportLlmProvider = async (input) => {
    prompts.push(input.prompt);
    return {
      candidates: [
        {
          objectKey: "skill.beautiful-article",
          kind: "skill",
          title: "Beautiful Article",
          selectedByDefault: true,
          confidence: 0.95,
        },
      ],
      proposedEdges: [
        {
          fromObjectKey: "agent.article-editor",
          edgeType: "uses",
          toObjectKey: "skill.beautiful-article",
          confidence: 0.92,
          rationale: "Article editor agents can use Beautiful Article.",
        },
        {
          fromObjectKey: "agent.draft-only",
          edgeType: "uses",
          toObjectKey: "skill.beautiful-article",
          confidence: 0.99,
          rationale: "Draft graph nodes must not be valid ontology endpoints.",
        },
        {
          fromObjectKey: "agent.article-editor",
          edgeType: "similar_to",
          toObjectKey: "agent.content-strategist",
          confidence: 0.75,
          rationale: "Both endpoints are existing nodes, so import linking rejects it.",
        },
      ],
    };
  };

  try {
    await upsertLibraryObject(db, {
      objectKey: "agent.article-editor",
      objectKind: "agent_definition",
      status: "approved",
      headVersionId: "agent.article-editor@1",
      state: {
        schemaVersion: "southstar.library.agent_definition.v1",
        title: "Article Editor",
        scope: "design",
        summary: "Edits source material into clear long-form articles.",
      },
    });
    await upsertLibraryObject(db, {
      objectKey: "agent.content-strategist",
      objectKind: "agent_definition",
      status: "approved",
      headVersionId: "agent.content-strategist@1",
      state: {
        schemaVersion: "southstar.library.agent_definition.v1",
        title: "Content Strategist",
        scope: "design",
        summary: "Plans editorial strategy.",
      },
    });
    await upsertLibraryObject(db, {
      objectKey: "agent.draft-only",
      objectKind: "agent_definition",
      status: "draft",
      headVersionId: "agent.draft-only@1",
      state: {
        schemaVersion: "southstar.library.agent_definition.v1",
        title: "Draft Only",
        scope: "design",
      },
    });

    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "beautiful article skill",
        content: "beautiful article skill helps agents produce polished single-file HTML articles",
      },
      scope: "design",
      llmProvider: provider,
    });

    const installed = await installLibraryImportCandidates(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      selectedCandidateIds: ["skill.beautiful-article"],
      actor: "operator",
      reason: "install beautiful article",
      llmProvider: provider,
      progress: (event) => progressEvents.push(event),
    });

    assert.deepEqual(installed.installedObjects.map((object) => object.objectKey), ["skill.beautiful-article"]);
    assert.equal(installed.installedObjects[0]?.object.status, "approved");
    assert.deepEqual(installed.installedEdges.map((edge) => ({
      fromObjectKey: edge.fromObjectKey,
      edgeType: edge.edgeType,
      toObjectKey: edge.toObjectKey,
      source: edge.metadata.source,
      draftId: edge.metadata.draftId,
      newObjectKeys: edge.metadata.newObjectKeys,
      confidence: edge.metadata.confidence,
    })), [
      {
        fromObjectKey: "agent.article-editor",
        edgeType: "uses",
        toObjectKey: "skill.beautiful-article",
        source: "library-import-ontology",
        draftId: draft.draftId,
        newObjectKeys: ["skill.beautiful-article"],
        confidence: 0.92,
      },
    ]);

    assert.match(prompts.at(-1) ?? "", /ExistingApprovedGraphNodes/);
    assert.match(prompts.at(-1) ?? "", /agent\.article-editor/);
    assert.doesNotMatch(prompts.at(-1) ?? "", /agent\.draft-only/);
    assert.ok(progressEvents.some((event) => event.event === "library.import.existing_graph.loaded"));
    assert.equal(
      progressEvents.find((event) => event.event === "library.import.ontology.completed")?.data.proposedEdgeCount,
      1,
    );

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal((resource?.payload as any).install.installedEdges[0].metadata.source, "library-import-ontology");
    assert.deepEqual((resource?.payload as any).install.installedObjectKeys, ["skill.beautiful-article"]);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("installLibraryImportCandidates preserves source markdown content for imported agent files", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-candidate-source-"));
  const repoRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-agent-source-"));
  const sourceContent = [
    "---",
    "name: 前端开发者",
    "description: 精通现代 Web 技术的前端开发专家",
    "---",
    "",
    "# 前端开发者 Agent 人格",
    "",
    "你是前端开发者，负责 React UI、可访问性和性能优化。",
    "",
  ].join("\n");
  const provider: LibraryImportLlmProvider = async () => ({
    candidates: [
      {
        objectKey: "agent.engineering-frontend-developer",
        kind: "agent",
        title: "前端开发者",
        sourcePath: "engineering/engineering-frontend-developer.md",
        selectedByDefault: true,
      },
    ],
    proposedEdges: [],
  });

  try {
    await mkdir(join(repoRoot, "engineering"), { recursive: true });
    await writeFile(join(repoRoot, "engineering", "engineering-frontend-developer.md"), sourceContent);
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "github",
        repoUrl: "https://github.com/jnMetaCode/agency-agents-zh",
      },
      scope: "software",
      sourceFetcher: async () => ({ documents: [], repoPath: repoRoot }),
      llmProvider: provider,
    });

    await installLibraryImportCandidates(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      selectedCandidateIds: ["agent.engineering-frontend-developer"],
      actor: "operator",
      reason: "preserve source content",
      llmProvider: provider,
    });

    const content = await readFile(join(libraryRoot, "agents/engineering-frontend-developer.agent.md"), "utf8");
    const parsed = parseLibraryFileContent({
      path: "library/agents/engineering-frontend-developer.agent.md",
      content,
    });
    assert.equal(parsed.ok, true);
    assert.match(content, /## Source Definition/);
    assert.match(content, /# 前端开发者 Agent 人格/);
    assert.match(content, /React UI、可访问性和性能优化/);
    assert.equal((await findLibraryObjectByKey(db, "agent.engineering-frontend-developer"))?.objectKind, "agent_definition");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("installLibraryImportCandidates copies full source skill directory for imported skills", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-skill-directory-"));
  const repoRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-skill-source-"));
  const skillRoot = join(repoRoot, "skills", "browser-verification");
  const provider: LibraryImportLlmProvider = async () => ({
    candidates: [
      {
        objectKey: "skill.browser-verification",
        kind: "skill",
        title: "Browser Verification",
        sourcePath: "skills/browser-verification/SKILL.md",
        selectedByDefault: true,
      },
    ],
    proposedEdges: [],
  });

  try {
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await mkdir(join(skillRoot, "scripts"), { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: browser-verification",
        "description: Verify browser UI behavior",
        "---",
        "",
        "# Browser Verification",
        "",
        "Use the browser to inspect candidate blocks and graph nodes.",
        "",
      ].join("\n"),
    );
    await writeFile(join(skillRoot, "references", "checklist.md"), "# Checklist\n\n- inspect UI\n");
    await writeFile(join(skillRoot, "scripts", "verify.sh"), "echo verify\n");

    const draft = await createLibraryImportDraft(db, {
      source: { kind: "github", repoUrl: "https://github.com/acme/skills" },
      scope: "software",
      sourceFetcher: async () => ({ documents: [], repoPath: repoRoot }),
      llmProvider: provider,
    });

    await installLibraryImportCandidates(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      selectedCandidateIds: ["skill.browser-verification"],
      actor: "operator",
      reason: "install full skill directory",
      llmProvider: provider,
    });

    const canonicalContent = await readFile(join(libraryRoot, "skills/browser-verification.skill.md"), "utf8");
    assert.match(canonicalContent, /## Source Definition/);
    assert.match(canonicalContent, /# Browser Verification/);
    assert.equal(
      await readFile(join(libraryRoot, "skills/browser-verification/SKILL.md"), "utf8"),
      await readFile(join(skillRoot, "SKILL.md"), "utf8"),
    );
    assert.equal(
      await readFile(join(libraryRoot, "skills/browser-verification/references/checklist.md"), "utf8"),
      "# Checklist\n\n- inspect UI\n",
    );
    assert.equal(
      await readFile(join(libraryRoot, "skills/browser-verification/scripts/verify.sh"), "utf8"),
      "echo verify\n",
    );
    assert.equal((await findLibraryObjectByKey(db, "skill.browser-verification"))?.objectKind, "skill_spec");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("installLibraryImportCandidates preflights all selected candidates before writing any file", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-candidate-preflight-"));
  const provider: LibraryImportLlmProvider = async () => ({
    candidates: [
      { objectKey: "agent.reviewer", kind: "agent", title: "Reviewer", selectedByDefault: true },
      { objectKey: "skill.existing", kind: "skill", title: "Existing", selectedByDefault: true },
    ],
    proposedEdges: [
      { fromObjectKey: "agent.reviewer", edgeType: "uses", toObjectKey: "skill.existing", confidence: 0.8 },
    ],
  });

  try {
    await mkdir(join(libraryRoot, "skills"), { recursive: true });
    await writeFile(join(libraryRoot, "skills/existing.skill.md"), "existing library truth", {
      encoding: "utf8",
      flag: "wx",
    });
    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "review docs",
        content: "create a browser verification skill that uses tool.browser",
      },
      scope: "software",
      llmProvider: provider,
    });

    await assert.rejects(
      () => installLibraryImportCandidates(db, {
        root: libraryRoot,
        draftId: draft.draftId,
        selectedCandidateIds: ["agent.reviewer", "skill.existing"],
        actor: "operator",
        reason: "one selected candidate collides",
      }),
      /library import file already exists: skills\/existing\.skill\.md/,
    );

    assert.equal(await readFile(join(libraryRoot, "skills/existing.skill.md"), "utf8"), "existing library truth");
    assert.deepEqual(
      (await listLibraryFiles({ root: libraryRoot })).map((file) => file.relativePath),
      ["skills/existing.skill.md"],
    );
    assert.equal(await findLibraryObjectByKey(db, "agent.reviewer"), null);
    assert.equal(await findLibraryObjectByKey(db, "skill.existing"), null);

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(resource?.status, "draft");
    assert.match((resource?.payload as any).lastError.message, /library import file already exists/);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("installLibraryImportCandidates adopts same-object draft files and syncs ontology edges", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-candidate-adopt-"));
  const provider: LibraryImportLlmProvider = async () => ({
    candidates: [
      { objectKey: "skill.beautiful-article", kind: "skill", title: "Beautiful Article", selectedByDefault: true, scope: "design" },
    ],
    proposedEdges: [
      {
        fromObjectKey: "agent.article-editor",
        edgeType: "uses",
        toObjectKey: "skill.beautiful-article",
        confidence: 0.92,
        rationale: "Article editor can use Beautiful Article for polished HTML article output.",
      },
    ],
  });

  try {
    await upsertLibraryObject(db, {
      objectKey: "agent.article-editor",
      objectKind: "agent_definition",
      status: "approved",
      headVersionId: "agent.article-editor@1",
      state: {
        schemaVersion: "southstar.library.agent_definition.v1",
        title: "Article Editor",
        scope: "design",
      },
    });
    await mkdir(join(libraryRoot, "skills"), { recursive: true });
    await writeFile(
      join(libraryRoot, "skills/beautiful-article.skill.md"),
      [
        "---",
        "schemaVersion: southstar.library.skill_spec_file.v1",
        "id: skill.beautiful-article",
        'title: "Beautiful Article"',
        'scope: "design"',
        "status: draft",
        'importDraftId: "previous-draft"',
        'importCandidateKey: "skill.beautiful-article"',
        "---",
        "",
        "# Instructions",
        "",
        "Previous partial draft content.",
        "",
      ].join("\n"),
      "utf8",
    );

    const draft = await createLibraryImportDraft(db, {
      source: {
        kind: "paste",
        label: "beautiful article skill",
        content: "beautiful article skill helps agents produce polished single-file HTML articles",
      },
      scope: "design",
      llmProvider: provider,
    });

    const installed = await installLibraryImportCandidates(db, {
      root: libraryRoot,
      draftId: draft.draftId,
      selectedCandidateIds: ["skill.beautiful-article"],
      actor: "operator",
      reason: "install same-object partial draft",
      llmProvider: provider,
    });

    assert.deepEqual(installed.installedObjects.map((object) => object.objectKey), ["skill.beautiful-article"]);
    assert.equal(installed.installedObjects[0]?.object.status, "approved");
    assert.equal((await findLibraryObjectByKey(db, "skill.beautiful-article"))?.status, "approved");
    assert.match(await readFile(join(libraryRoot, "skills/beautiful-article.skill.md"), "utf8"), /status: approved/);
    const edges = await findLibraryEdgesFrom(db, "agent.article-editor", "uses", { scope: "design" });
    assert.deepEqual(edges.map((edge) => edge.toObjectKey), ["skill.beautiful-article"]);
    assert.equal(edges[0]?.metadata.source, "library-import-ontology");

    const resource = await getResourceByKeyPg(db, "library_import_draft", draft.draftId);
    assert.equal(resource?.status, "installed");
    assert.deepEqual((resource?.payload as any).install.installedObjectKeys, ["skill.beautiful-article"]);
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
  let llmPrompt = "";
  const libraryImportSourceFetcher: LibraryImportSourceFetcher = async () => ({
    documents: [],
    repoPath: "/tmp/southstar-library-imports/acme-library",
  });
  const libraryImportLlmProvider: LibraryImportLlmProvider = async ({ prompt }) => {
    llmPrompt = prompt;
    return {
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
    };
  };

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
        requestPrompt: "import 266 agents from https://github.com/acme/library",
      }),
    }));

    assert.equal(response.status, 200);
    const envelope = await response.json() as any;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.kind, "library-import-draft");
    assert.deepEqual(envelope.result.documents.map((doc: any) => doc.path), [
    ]);
    assert.deepEqual(envelope.result.candidates.map((candidate: any) => candidate.objectKey), [
      "agent.reviewer",
      "skill.review",
    ]);
    assert.deepEqual(envelope.result.proposedEdges, []);
    assert.match(llmPrompt, /UserImportRequest:\nimport 266 agents from https:\/\/github\.com\/acme\/library/);
    assert.match(llmPrompt, /LocalRepositoryPath:\n\/tmp\/southstar-library-imports\/acme-library/);
    const resource = await getResourceByKeyPg(db, "library_import_draft", envelope.result.draftId);
    assert.equal((resource?.payload as any).requestPrompt, "import 266 agents from https://github.com/acme/library");
    assert.equal((resource?.payload as any).sourceRepoPath, "/tmp/southstar-library-imports/acme-library");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("POST /api/v2/library/import-drafts/:draftId/install installs selected candidates", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-import-route-install-"));
  const libraryImportLlmProvider: LibraryImportLlmProvider = async () => ({
    candidates: [
      { objectKey: "agent.reviewer", kind: "agent", title: "Reviewer", selectedByDefault: true },
      { objectKey: "skill.review", kind: "skill", title: "Review", selectedByDefault: true },
    ],
    proposedEdges: [
      {
        fromObjectKey: "agent.reviewer",
        edgeType: "uses",
        toObjectKey: "skill.review",
        confidence: 0.86,
        rationale: "Reviewer uses review skill.",
      },
    ],
  });

  try {
    const context = { db, libraryRoot, libraryImportLlmProvider } as any;
    const draftResponse = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/import-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { kind: "paste", label: "review docs", content: "reviewer uses review skill" },
        scope: "software",
      }),
    }));
    const draftEnvelope = await draftResponse.json() as any;

    const installResponse = await handleRuntimeRoute(context, new Request(`http://local/api/v2/library/import-drafts/${draftEnvelope.result.draftId}/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selectedCandidateIds: ["agent.reviewer", "skill.review"],
        actor: "operator",
        reason: "install reviewed candidates",
      }),
    }));

    assert.equal(installResponse.status, 200);
    const installEnvelope = await installResponse.json() as any;
    assert.equal(installEnvelope.ok, true);
    assert.equal(installEnvelope.kind, "library-import-candidate-install");
    assert.equal(installEnvelope.result.status, "installed");
    assert.deepEqual(
      installEnvelope.result.installedObjects.map((object: any) => object.relativePath),
      ["agents/reviewer.agent.md", "skills/review.skill.md"],
    );
    assert.deepEqual(
      installEnvelope.result.installedEdges.map((edge: any) => edge.edgeType),
      ["uses"],
    );

    const agentContent = await readFile(join(libraryRoot, "agents/reviewer.agent.md"), "utf8");
    assert.match(agentContent, /schemaVersion: southstar\.library\.agent_definition_file\.v1/);
    assert.equal((await findLibraryObjectByKey(db, "agent.reviewer"))?.objectKind, "agent_definition");
    assert.equal((await findLibraryObjectByKey(db, "skill.review"))?.objectKind, "skill_spec");

    const resource = await getResourceByKeyPg(db, "library_import_draft", draftEnvelope.result.draftId);
    assert.equal(resource?.status, "installed");
    assert.equal((resource?.payload as any).install.reason, "install reviewed candidates");
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
    assert.deepEqual(
      asImportSource({ type: "github", url: "https://github.com/acme/library" }),
      { kind: "github", repoUrl: "https://github.com/acme/library" },
    );
    assert.deepEqual(asImportSource({ kind: "github", url: "https://github.com/acme/library" }), {
      kind: "github",
      repoUrl: "https://github.com/acme/library",
    });

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
