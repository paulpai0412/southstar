"use client";

import { useEffect, useState } from "react";
import type { GoalMissionReadModel, WorkflowCommandDescriptor } from "@/lib/workflow/types";

type WorkflowUiReadModel = {
  mission: GoalMissionReadModel | null;
  commands: WorkflowCommandDescriptor[];
};

type InspectorState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; model: WorkflowUiReadModel };

export function GoalContractInspector({ draftId, runId, refreshKey = 0 }: { draftId?: string; runId?: string; refreshKey?: number }) {
  const [state, setState] = useState<InspectorState>({ status: "loading" });
  const url = workflowUiUrl(draftId, runId);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
        const payload = await response.json() as { result?: WorkflowUiReadModel } & WorkflowUiReadModel;
        return payload.result ?? payload;
      })
      .then((model) => setState({ status: "ready", model }))
      .catch((error) => {
        if (!controller.signal.aborted) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [refreshKey, url]);

  if (!url) return <div data-testid="goal-contract-inspector" className="goal-contract-inspector operator-danger">draftId or runId is required</div>;
  if (state.status === "loading") return <div data-testid="goal-contract-inspector" className="goal-contract-inspector">Loading Goal Contract…</div>;
  if (state.status === "error") return <div data-testid="goal-contract-inspector" className="goal-contract-inspector operator-danger">{state.message}</div>;
  const mission = state.model.mission;
  if (!mission) return <div data-testid="goal-contract-inspector" className="goal-contract-inspector">No Goal Contract is available.</div>;
  const contract = mission.goalContract;
  return (
    <div data-testid="goal-contract-inspector" className="goal-contract-inspector">
      <header><span>Goal Contract</span><strong>{contract.summary}</strong></header>
      <InspectorSection title="Requirements">
        <div data-testid="goal-contract-requirements">
          {contract.requirements.map((requirement) => (
            <article key={requirement.id}>
              <strong>{requirement.statement}</strong>
              <ul>{requirement.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
            </article>
          ))}
        </div>
      </InspectorSection>
      <InspectorSection title="Deliverables"><StringList values={contract.expectedArtifactRefs} /></InspectorSection>
      <InspectorSection title="Boundaries"><StringList values={contract.nonGoals} /></InspectorSection>
      <InspectorSection title="Assumptions / blocking inputs"><StringList values={[...contract.assumptions, ...contract.blockingInputs]} /></InspectorSection>
      <InspectorSection title="Risk / requested side effects"><StringList values={[...contract.riskTags, ...contract.requestedSideEffects]} /></InspectorSection>
      <InspectorSection title="Coverage / evaluator evidence">
        <div data-testid="goal-contract-evaluator-evidence">
          <p>{mission.coverage.covered}/{mission.coverage.total} covered · {mission.evaluatorResults.length} evaluator results</p>
          <StringList values={[
            ...(mission.coverage.failedRequirementIds.length > 0
              ? [`failed requirements: ${mission.coverage.failedRequirementIds.join(", ")}`]
              : ["failed requirements: none"]),
            ...mission.coverage.entries.flatMap((entry) => [
              `${entry.requirementId} producers: ${entry.producerTaskIds.join(", ") || "none"}`,
              `${entry.requirementId} artifacts: ${entry.artifactRefs.join(", ") || "none"}`,
              `${entry.requirementId} evaluator tasks: ${entry.evaluatorTaskIds.join(", ") || "none"}`,
              `${entry.requirementId} evaluator profiles: ${entry.evaluatorProfileRefs.join(", ") || "none"}`,
              `${entry.requirementId} evidence kinds: ${entry.requiredEvidenceKinds.join(", ") || "none"}`,
            ]),
          ]} />
          {mission.evaluatorResults.map((result, index) => (
            <article key={evaluatorResultKey(result, index)}>
              <strong>Evaluator result {index + 1}</strong>
              <StringList values={evaluatorEvidenceLines(result)} />
            </article>
          ))}
        </div>
      </InspectorSection>
      <InspectorSection title="Provenance / hashes">
        <StringList values={[
          `revision ${mission.provenance.revision}`,
          `prompt ${mission.provenance.promptHash}`,
          `contract ${mission.goalContractHash}`,
          ...(mission.provenance.manifestHash ? [`manifest ${mission.provenance.manifestHash}`] : []),
          ...(mission.provenance.librarySnapshotHash ? [`library ${mission.provenance.librarySnapshotHash}`] : []),
        ]} />
      </InspectorSection>
    </div>
  );
}

function workflowUiUrl(draftId?: string, runId?: string): string | null {
  if (runId) return `/api/workflow/ui?runId=${encodeURIComponent(runId)}`;
  if (draftId) return `/api/workflow/ui?draftId=${encodeURIComponent(draftId)}`;
  return null;
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3>{title}</h3>{children}</section>;
}

function StringList({ values }: { values: string[] }) {
  return values.length > 0 ? <ul>{values.map((value, index) => <li key={`${value}:${index}`}>{value}</li>)}</ul> : <p>None</p>;
}

function evaluatorResultKey(value: unknown, index: number): string {
  const result = recordValue(value);
  return `${stringValue(result?.evaluatorId) ?? stringValue(result?.evaluatorTaskId) ?? "evaluator"}:${index}`;
}

function evaluatorEvidenceLines(value: unknown): string[] {
  const result = recordValue(value);
  if (!result) return [String(value)];
  return [
    ...(stringValue(result.evaluatorId) ? [`evaluator: ${stringValue(result.evaluatorId)}`] : []),
    ...(stringValue(result.evaluatorTaskId) ? [`evaluator task: ${stringValue(result.evaluatorTaskId)}`] : []),
    ...(stringValue(result.evaluatorProfileRef) ? [`evaluator profile: ${stringValue(result.evaluatorProfileRef)}`] : []),
    ...(stringValue(result.verdict) ? [`verdict: ${stringValue(result.verdict)}`] : []),
    ...labeledValues("requirements", result.requirementIds),
    ...labeledValues("artifacts", result.artifactRefs),
    ...labeledValues("evidence", result.evidenceRefs),
    ...labeledValues("findings / reason", result.findings),
    ...(stringValue(result.reason) ? [`reason: ${stringValue(result.reason)}`] : []),
  ];
}

function labeledValues(label: string, value: unknown): string[] {
  const values = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return values.length > 0 ? [`${label}: ${values.join(", ")}`] : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
