export type SkillResourceFile = {
  resourcePath: string;
  label: string;
};

export type SkillResourceGroup = {
  skillName: string;
  files: SkillResourceFile[];
};

export function groupSkillResourcePaths(resourcePaths: string[]): SkillResourceGroup[] {
  const groups = new Map<string, SkillResourceGroup>();
  const seenFiles = new Set<string>();
  for (const resourcePath of resourcePaths) {
    if (seenFiles.has(resourcePath)) continue;
    seenFiles.add(resourcePath);
    const parsed = parseSkillResourcePath(resourcePath);
    if (!parsed) continue;
    const group = groups.get(parsed.skillName) ?? { skillName: parsed.skillName, files: [] };
    group.files.push({ resourcePath, label: parsed.label });
    groups.set(parsed.skillName, group);
  }
  return [...groups.values()];
}

function parseSkillResourcePath(resourcePath: string): { skillName: string; label: string } | null {
  const normalized = resourcePath.replaceAll("\\", "/");
  const metadataMatch = normalized.match(/^library\/skills\/([^/]+)\.skill\.md$/);
  if (metadataMatch?.[1]) {
    return {
      skillName: metadataMatch[1],
      label: `${metadataMatch[1]}.skill.md`,
    };
  }
  const bundleMatch = normalized.match(/^library\/skills\/([^/]+)\/(.+)$/);
  if (bundleMatch?.[1] && bundleMatch[2]) {
    return {
      skillName: bundleMatch[1],
      label: bundleMatch[2],
    };
  }
  const fallback = normalized.split("/").at(-1);
  return fallback ? { skillName: "unknown", label: fallback } : null;
}
