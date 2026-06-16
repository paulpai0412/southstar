import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import {
  appendDraftEvent,
  appendVersionCreated,
  createLibraryObject,
  getLibraryVersion,
  listLibraryHistory,
  listLibraryVersions,
} from "../../src/v2/design-library/store.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";
import { contentHashForPayload } from "../../src/v2/design-library/canonical-json.ts";

const kinds = [
  "agent_spec",
  "capability_spec",
  "contract_spec",
  "validator_spec",
  "policy_bundle",
  "workflow_template",
  "workflow_recipe",
] as const;

test("design library schema creates canonical 2+1 tables", () => {
  const db = openSouthstarDb(":memory:");
  const rows = db.prepare(`
    select name from sqlite_master
    where type = 'table' and name like 'library_%'
    order by name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(rows.map((row) => row.name), [
    "library_history",
    "library_objects",
    "library_similarity_index",
  ]);
});

test("version.created stores canonical sha256 and append-only history", () => {
  const db = openSouthstarDb(":memory:");
  const object = createLibraryObject(db, {
    objectKey: "software.agent.explorer",
    objectKind: "agent_spec",
    status: "approved",
    state: { domainRefs: ["software"], tags: ["explorer"] },
    actorType: "migration",
  });
  const payload = {
    schemaVersion: "southstar.library.agent_spec.v1",
    identity: { displayName: "Explorer", description: "Inspects repo", domainRefs: ["software"], roleRefs: ["explorer"], capabilityTags: ["repo-read"] },
    responsibilities: { goals: ["understand issue and repo"], nonGoals: ["modify files"], stopAuthority: "can-suggest" },
    executionProfiles: [{ id: "default", provider: "pi", model: "pi-default", harnessRef: "pi", complexityBand: "moderate", preferredFor: ["repo inspection"], fallbackFor: [], budget: { maxInputTokens: 8000, maxOutputTokens: 2000 } }],
    prompts: { system: "Inspect the repository and produce a concise implementation plan.", taskTemplates: [{ id: "issue-analysis", body: "Analyze {{issueTitle}} against {{repoPath}}." }], outputRules: ["Return JSON artifact"], safetyRules: ["Do not edit files"] },
    capabilities: { skillRefs: ["software.repo-read"], mcpCapabilityRefs: [], requiredToolCapabilities: ["filesystem-read"], memoryScopes: ["software"] },
    policies: {},
    contracts: { inputContractRefs: ["software.issue-input"], outputContractRefs: ["software.implementation-plan"], evidenceContractRefs: ["software.repo-evidence"], validatorRefs: ["software.schema-validator"] },
    provenance: { source: "seed", createdBy: "migration" },
  };

  const version = appendVersionCreated(db, {
    objectId: object.objectId,
    definitionKind: "agent_spec",
    versionId: "ver-1.0.0",
    payload,
    createdBy: "migration",
    status: "approved",
  });

  assert.equal(version.contentHash, contentHashForPayload(payload));
  assert.deepEqual(getLibraryVersion(db, version.versionId)?.payload, payload);
  assert.equal(listLibraryVersions(db, object.objectId).length, 1);
  assert.equal(listLibraryHistory(db, { objectId: object.objectId }).length, 2);
});

test("software-dev seed creates approved version.created events across all definition kinds", () => {
  const db = openSouthstarDb(":memory:");
  const seed = seedSoftwareDevDesignLibrary(db, { actorType: "migration" });

  assert.equal(seed.createdVersionIds.length >= 14, true, `expected >=14 versions, got ${seed.createdVersionIds.length}`);
  for (const kind of kinds) {
    const count = db.prepare(`
      select count(*) as count
      from library_history
      where event_type = 'version.created'
        and json_extract(payload_json, '$.definitionKind') = ?
    `).get(kind) as { count: number };
    assert.equal(count.count > 0, true, `missing seeded ${kind}`);
  }

  const llmApproved = db.prepare(`
    select count(*) as count
    from library_history
    where event_type = 'version.created'
      and actor_type = 'llm'
  `).get() as { count: number };
  assert.equal(llmApproved.count, 0);
});

test("LLM may append draft events but cannot append approved version events", () => {
  const db = openSouthstarDb(":memory:");
  const object = createLibraryObject(db, {
    objectKey: "llm.proposed.capability",
    objectKind: "capability_spec",
    status: "draft",
    state: { domainRefs: ["software"], tags: ["proposal"] },
    actorType: "llm",
  });

  appendDraftEvent(db, {
    objectId: object.objectId,
    eventType: "draft.opened",
    status: "draft",
    payload: { proposedKind: "capability_spec", title: "Browser capture" },
    actorType: "llm",
  });

  assert.throws(() => appendVersionCreated(db, {
    objectId: object.objectId,
    definitionKind: "capability_spec",
    versionId: "ver-1.0.0",
    payload: { schemaVersion: "southstar.library.capability_spec.v1" },
    createdBy: "llm",
    status: "approved",
  }), /LLM cannot create approved library versions/i);
});
