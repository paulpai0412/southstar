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

export function GoalContractInspector({ draftId, runId }: { draftId?: string; runId?: string }) {
  const [state, setState] = useState<InspectorState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(workflowUiUrl(draftId, runId), { cache: "no-store", signal: controller.signal })
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
  }, [draftId, runId]);

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
        <p>{mission.coverage.covered}/{mission.coverage.total} covered · {mission.evaluatorResults.length} evaluator results</p>
        <StringList values={mission.coverage.entries.flatMap((entry) => [
          `${entry.requirementId}: ${entry.producerTaskIds.join(", ") || "no producer"}`,
          ...entry.requiredEvidenceKinds,
        ])} />
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

function workflowUiUrl(draftId?: string, runId?: string): string {
  if (runId) return `/api/workflow/ui?runId=${encodeURIComponent(runId)}`;
  if (draftId) return `/api/workflow/ui?draftId=${encodeURIComponent(draftId)}`;
  throw new Error("draftId or runId is required");
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3>{title}</h3>{children}</section>;
}

function StringList({ values }: { values: string[] }) {
  return values.length > 0 ? <ul>{values.map((value, index) => <li key={`${value}:${index}`}>{value}</li>)}</ul> : <p>None</p>;
}
