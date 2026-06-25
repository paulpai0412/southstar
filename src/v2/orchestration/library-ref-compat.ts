export type LibraryRefKind = "instruction" | "skill" | "tool" | "mcp" | "vault";

const LEGACY_LIBRARY_REF_MAPS: Record<LibraryRefKind, Record<string, string>> = {
  instruction: {
    "software.explorer": "instruction.software-explorer",
    "software.spec-reviewer": "instruction.software-spec-reviewer",
    "software.maker": "instruction.software-maker",
    "software.checker": "instruction.software-checker",
    "software.code-quality-reviewer": "instruction.software-code-quality-reviewer",
    "software.summarizer": "instruction.software-summarizer",
  },
  skill: {
    "software.calc-cli": "skill.software-implementation",
    "software.repo-discovery": "skill.software-repo-discovery",
    "software.spec-review": "skill.software-spec-review",
    "software.implementation": "skill.software-implementation",
    "software.verification": "skill.software-verification",
    "software.code-quality-review": "skill.software-code-quality-review",
    "software.summary": "skill.software-summary",
  },
  tool: {
    "software.workspace-read": "tool.workspace-read",
    "software.workspace-write": "tool.workspace-write",
    "software.shell-command": "tool.shell-command",
  },
  mcp: {
    "filesystem-workspace": "mcp.filesystem-workspace",
    "software.filesystem-workspace": "mcp.filesystem-workspace",
  },
  vault: {
    "software.github-write-token": "vault.github-write-token",
  },
};

export function normalizeLibraryRef(input: { value: string; prefix: string; kind: LibraryRefKind }): string {
  if (input.value.startsWith(input.prefix)) return input.value;
  const mapped = LEGACY_LIBRARY_REF_MAPS[input.kind][input.value];
  return mapped ?? input.value;
}

export function normalizeLibraryRefs(input: { values?: string[]; prefix: string; kind: LibraryRefKind }): string[] {
  const normalized = (input.values ?? []).map((value) => normalizeLibraryRef({ value, prefix: input.prefix, kind: input.kind }));
  return [...new Set(normalized)];
}
