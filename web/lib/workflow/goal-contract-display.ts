import { useEffect, useState } from "react";
import { readLibraryObjectDetail } from "../library/api";
import type { LibraryObjectDetail } from "../library/types";

type ContractRequirementShape = {
  acceptanceCriteria?: readonly string[];
  blocking?: boolean;
};

const riskDescriptions: Record<string, string> = {
  "secret-access": "May read credentials through an approved lease.",
  "external-write": "May write to an external system or service.",
  deployment: "May deploy or change a running environment.",
  delete: "May delete or destroy data.",
  "production-change": "May change production resources.",
  "cost-high": "May incur high provider or infrastructure cost.",
  "workspace-write": "May write files in the selected workspace.",
  "network-access": "May use network access.",
};

const sideEffectDescriptions: Record<string, string> = {
  "workspace-write": "Writes files in the selected workspace.",
  "network-access": "Uses network access during execution.",
  "external-write": "Writes to an external system or service.",
  "secret-access": "Uses credentials through an approved lease.",
  deployment: "Changes or deploys a running environment.",
};

export function humanizeReference(value: string): string {
  const words = value
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[._:/-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "Unlabelled reference";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function describeRiskTag(tag: string): string {
  return riskDescriptions[tag] ?? `${humanizeReference(tag)} requires an explicit operator review.`;
}

export function describeSideEffect(effect: string): string {
  return sideEffectDescriptions[effect] ?? `${humanizeReference(effect)} is requested by this goal.`;
}

export function scopeEffortDescription(contract: { requirements: readonly ContractRequirementShape[] }): string {
  const requirementCount = contract.requirements.length;
  const criterionCount = contract.requirements.reduce((total, requirement) => total + (requirement.acceptanceCriteria?.length ?? 0), 0);
  const blockingCount = contract.requirements.filter((requirement) => requirement.blocking).length;
  return `Scope: ${requirementCount} requirement${requirementCount === 1 ? "" : "s"}, ${criterionCount} acceptance criteria, ${blockingCount} blocking item${blockingCount === 1 ? "" : "s"}. Execution effort estimate is not recorded in the Goal Contract; review the composed DAG task count before running.`;
}

export function describeLibraryObject(
  detail: Pick<LibraryObjectDetail, "object">,
  kind: "artifact" | "evaluator",
): string {
  const state = detail.object.state ?? {};
  const title = stringValue(state.title) ?? humanizeReference(detail.object.objectKey);
  const description = stringValue(state.description) ?? stringValue(state.summary);
  const fields = kind === "artifact"
    ? [
        title,
        description,
        stringValue(state.schemaRef) ? `schema: ${stringValue(state.schemaRef)}` : undefined,
        stringArray(state.mediaTypes).length > 0 ? `media: ${stringArray(state.mediaTypes).join(", ")}` : undefined,
        stringArray(state.requiredFields).length > 0 ? `fields: ${stringArray(state.requiredFields).join(", ")}` : undefined,
      ]
    : [
        title,
        description,
        stringArray(state.verificationModes).length > 0 ? `modes: ${stringArray(state.verificationModes).join(", ")}` : undefined,
        stringValue(state.resultSchemaRef) ? `result: ${stringValue(state.resultSchemaRef)}` : undefined,
        stringArray(state.requiredInputs).length > 0 ? `inputs: ${stringArray(state.requiredInputs).join(", ")}` : undefined,
      ];
  return fields.filter((value): value is string => Boolean(value)).join(" · ");
}

export function describeDeliverable(ref: string, details: Record<string, LibraryObjectDetail>): string {
  return details[ref] ? describeLibraryObject(details[ref], "artifact") : humanizeReference(ref);
}

export function describeContractDeliverable(
  ref: string,
  contract: { requirements: ReadonlyArray<{ id: string; expectedArtifacts?: ReadonlyArray<{ description: string; path?: string; mediaType?: string }> }> },
  details: Record<string, LibraryObjectDetail>,
): string {
  if (details[ref]) return describeLibraryObject(details[ref], "artifact");
  for (const requirement of contract.requirements) {
    const prefix = `artifact.goal.${requirement.id}.`;
    if (!ref.startsWith(prefix)) continue;
    const index = Number(ref.slice(prefix.length)) - 1;
    const artifact = Number.isInteger(index) && index >= 0 ? requirement.expectedArtifacts?.[index] : undefined;
    if (artifact) {
      return [
        artifact.description,
        artifact.mediaType ? `media: ${artifact.mediaType}` : undefined,
        artifact.path ? `path: ${artifact.path}` : undefined,
      ].filter((value): value is string => Boolean(value)).join(" · ");
    }
  }
  return describeDeliverable(ref, details);
}

export function useLibraryObjectDetails(refs: readonly string[]): Record<string, LibraryObjectDetail> {
  const refKey = [...new Set(refs)].join("\u0000");
  const [details, setDetails] = useState<Record<string, LibraryObjectDetail>>({});

  useEffect(() => {
    const requestedRefs = refKey ? refKey.split("\u0000") : [];
    let active = true;
    setDetails({});
    if (requestedRefs.length === 0) return () => { active = false; };

    void Promise.all(requestedRefs.map(async (ref) => {
      try {
        return [ref, await readLibraryObjectDetail(ref)] as const;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (!active) return;
      setDetails(Object.fromEntries(entries.filter((entry): entry is readonly [string, LibraryObjectDetail] => Boolean(entry))));
    });
    return () => { active = false; };
  }, [refKey]);

  return details;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}
