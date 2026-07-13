import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LibraryFileRecord } from "../../src/v2/design-library/files/library-file-types.ts";
import {
  loadLibraryFileCatalog,
  resolveClosedApprovedLibraryFileSet,
  validateRequiredLibraryPurposes,
} from "../../src/v2/design-library/files/library-reconcile-service.ts";

function record(input: {
  objectKey: string;
  kind?: LibraryFileRecord["kind"];
  status?: LibraryFileRecord["status"];
  purpose?: string;
  refs?: string[];
}): LibraryFileRecord {
  const kind = input.kind ?? "skill";
  return {
    path: `library/${kind}s/${input.objectKey}.${kind === "skill" ? "skill.md" : "tool.yaml"}`,
    kind,
    objectKey: input.objectKey,
    objectKind: kind === "skill" ? "skill_spec" : "tool_definition",
    id: input.objectKey,
    title: input.objectKey,
    scope: "global",
    status: input.status ?? "approved",
    schemaVersion: kind === "skill"
      ? "southstar.library.skill_spec_file.v1"
      : "southstar.library.tool_definition_file.v1",
    frontmatter: {
      id: input.objectKey,
      title: input.objectKey,
      scope: "global",
      status: input.status ?? "approved",
      purpose: input.purpose,
      requiresToolRefs: input.refs ?? [],
    },
    definition: {
      id: input.objectKey,
      title: input.objectKey,
      scope: "global",
      status: input.status ?? "approved",
      purpose: input.purpose,
      requiresToolRefs: input.refs ?? [],
    },
    body: "Use this instruction body.",
    sourceHash: input.objectKey.padEnd(64, "0").slice(0, 64),
  };
}

test("closed approved set recursively excludes files with missing references", () => {
  const tool = record({ objectKey: "tool.present", kind: "tool" });
  const closed = record({ objectKey: "skill.closed", refs: ["tool.present"] });
  const directMissing = record({ objectKey: "skill.direct", refs: ["tool.missing"] });
  const transitiveMissing = record({ objectKey: "skill.transitive", refs: ["skill.direct"] });
  const result = resolveClosedApprovedLibraryFileSet([tool, closed, directMissing, transitiveMissing]);
  assert.deepEqual(result.included.map((item) => item.objectKey).sort(), ["skill.closed", "tool.present"]);
  assert.deepEqual(result.excluded.map((item) => item.objectKey).sort(), ["skill.direct", "skill.transitive"]);
  assert.deepEqual(result.excluded.find((item) => item.objectKey === "skill.direct")?.missingRefs, ["tool.missing"]);
  assert.deepEqual(
    resolveClosedApprovedLibraryFileSet([transitiveMissing, directMissing, closed, tool]),
    result,
  );
});

test("closed approved diagnostics recompute transitive missing references independent of input order", () => {
  const root = record({ objectKey: "skill.root", refs: ["skill.branch-a", "skill.branch-b"] });
  const branchA = record({ objectKey: "skill.branch-a", refs: ["tool.missing-a"] });
  const branchB = record({ objectKey: "skill.branch-b", refs: ["tool.missing-b"] });

  const first = resolveClosedApprovedLibraryFileSet([root, branchA, branchB]);
  const second = resolveClosedApprovedLibraryFileSet([branchA, root, branchB]);

  assert.deepEqual(second, first);
  assert.deepEqual(first.excluded.find((item) => item.objectKey === "skill.root")?.missingRefs, [
    "skill.branch-a",
    "skill.branch-b",
  ]);
});

test("catalog discovers every supported Library file kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-kinds-"));
  const cases = [
    ["agents/a.agent.md", "southstar.library.agent_definition_file.v1", "agent.a"],
    ["skills/s.skill.md", "southstar.library.skill_spec_file.v1", "skill.s"],
    ["tools/t.tool.yaml", "southstar.library.tool_definition_file.v1", "tool.t"],
    ["mcp/m.mcp.yaml", "southstar.library.mcp_grant_file.v1", "mcp.m"],
    ["vault/v.vault.yaml", "southstar.library.vault_lease_policy_file.v1", "vault.v"],
    ["profiles/p.profile.yaml", "southstar.library.generated_agent_profile_file.v1", "profile.p"],
    ["workflows/w.workflow.yaml", "southstar.library.workflow_template_file.v1", "workflow.w"],
    ["capabilities/c.capability.yaml", "southstar.library.capability_spec_file.v1", "capability.c"],
    ["artifacts/a.artifact.yaml", "southstar.library.artifact_contract_file.v1", "artifact.a"],
    ["domains/d.domain.yaml", "southstar.library.domain_taxonomy_file.v1", "domain.d"],
    ["evaluators/e.evaluator.yaml", "southstar.library.evaluator_profile_file.v1", "evaluator.e"],
  ] as const;
  for (const [relativePath, schemaVersion, id] of cases) {
    await mkdir(join(root, relativePath.split("/")[0]!), { recursive: true });
    const common = `schemaVersion: ${schemaVersion}\nid: ${id}\ntitle: ${id}\nscope: global\nstatus: draft\n`;
    const content = relativePath.endsWith(".md") ? `---\n${common}---\ninstructions\n` : common;
    await writeFile(join(root, relativePath), content);
  }
  const catalog = await loadLibraryFileCatalog({ root });
  assert.deepEqual(new Set(catalog.records.map((file) => file.kind)), new Set([
    "agent", "skill", "tool", "mcp", "vault", "generated_profile", "workflow_template",
    "capability", "artifact", "domain", "evaluator",
  ]));
});

test("required purposes are metadata-driven and require exactly one non-empty skill body", () => {
  const goal = record({ objectKey: "skill.any-goal-id", purpose: "goal_design" });
  const composer = record({ objectKey: "skill.any-composer-id", purpose: "composer_guidance" });
  assert.deepEqual(validateRequiredLibraryPurposes([goal, composer]), []);
  assert.match(validateRequiredLibraryPurposes([goal])[0]?.message ?? "", /composer_guidance.*found 0/);
  assert.match(validateRequiredLibraryPurposes([goal, { ...goal, objectKey: "skill.duplicate" }, composer])[0]?.message ?? "", /goal_design.*found 2/);
});

test("catalog reports invalid draft but marks invalid approved as fatal", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  await mkdir(join(root, "skills"));
  await writeFile(join(root, "skills", "draft.skill.md"), `---\nschemaVersion: wrong\nid: skill.draft\ntitle: Draft\nscope: global\nstatus: draft\n---\nbody\n`);
  await writeFile(join(root, "skills", "approved.skill.md"), `---\nschemaVersion: wrong\nid: skill.approved\ntitle: Approved\nscope: global\nstatus: approved\n---\nbody\n`);
  const catalog = await loadLibraryFileCatalog({ root });
  assert.equal(catalog.records.length, 0);
  assert.equal(catalog.diagnostics.length, 2);
  assert.equal(catalog.diagnostics.find((item) => item.objectKey === "skill.draft")?.fatal, false);
  assert.equal(catalog.diagnostics.find((item) => item.objectKey === "skill.approved")?.fatal, true);
});

test("catalog makes duplicate object keys fatal and names both paths", async () => {
  const result = resolveClosedApprovedLibraryFileSet([
    record({ objectKey: "skill.same" }),
    { ...record({ objectKey: "skill.same" }), path: "library/skills/second.skill.md" },
  ]);
  assert.equal(result.diagnostics[0]?.code, "duplicate_object_key");
  assert.deepEqual(result.diagnostics[0]?.paths.sort(), [
    "library/skills/second.skill.md",
    "library/skills/skill.same.skill.md",
  ]);
});
