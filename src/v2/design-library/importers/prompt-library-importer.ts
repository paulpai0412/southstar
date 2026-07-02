export type LibraryPromptImportProposal = {
  files: Array<{ relativePath: string; content: string }>;
  objectKeys: string[];
};

export function createPromptLibraryImportProposal(input: {
  prompt: string;
  scope: string;
}): LibraryPromptImportProposal {
  const normalized = input.prompt.toLowerCase();
  if (normalized.includes("skill")) {
    const id = normalized.includes("browser") ? "skill.browser-verification" : "skill.generated";
    const title = normalized.includes("browser") ? "Browser Verification" : "Generated Skill";
    const slug = id.replace(/^skill\./, "");
    return {
      files: [{
        relativePath: `skills/${slug}.skill.md`,
        content: `---
schemaVersion: southstar.library.skill_spec_file.v1
id: ${id}
title: ${title}
scope: ${input.scope}
status: draft
requiresCapabilityRefs:
  - capability.browser-verification
requiresToolRefs:
  - tool.browser
requiresMcpRefs: []
---

# Instructions

- Verify browser-visible behavior.
- Report visited URL, observed state, and evidence.
`,
      }],
      objectKeys: [id],
    };
  }

  throw new Error("prompt import currently supports create skill prompts in the first implementation slice");
}
