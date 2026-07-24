"use client";

import { useEffect, useState } from "react";
import { describeContractDeliverable, describeRiskTag, describeSideEffect, scopeEffortDescription, useLibraryObjectDetails } from "@/lib/workflow/goal-contract-display";
import type { GoalMissionReadModel, WorkflowCommandDescriptor, WorkflowLineageReadModel } from "@/lib/workflow/types";
import type { LibraryGraphChartEdge, LibraryGraphChartNode } from "./library/LibraryGraphChart";

type WorkflowUiReadModel = {
  mission: GoalMissionReadModel | null;
  lineage?: WorkflowLineageReadModel | null;
  commands: WorkflowCommandDescriptor[];
};

type InspectorState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; model: WorkflowUiReadModel };

export function GoalContractInspector({ draftId, runId, refreshKey = 0 }: { draftId?: string; runId?: string; refreshKey?: number }) {
  const [state, setState] = useState<InspectorState>({ status: "loading" });
  const url = workflowUiUrl(draftId, runId);
  const artifactRefs = state.status === "ready" && state.model.mission ? state.model.mission.goalContract.expectedArtifactRefs : [];
  const libraryDetails = useLibraryObjectDetails(artifactRefs);

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
      <details data-testid="goal-contract-inspector-guide" className="goal-contract-inspector-guide">
        <summary>How to use this contract and evaluator view</summary>
        <div>
          <p>The Goal Contract is the shared mission definition. It is not the DAG itself: the DAG is the execution plan that must satisfy this contract.</p>
          <p><strong>Requirement evaluator result</strong> is the pass/fail evidence for a requirement. Artifact refs identify the product output; coverage maps requirement → producer task → artifact → evaluator.</p>
          <p>Use this view to check persisted runtime truth after refresh. If evidence or coverage is missing, revise the contract or workflow rather than treating a technical ID as proof.</p>
        </div>
      </details>
      <InspectorSection title="Requirements">
        <div data-testid="goal-contract-requirements">
          {contract.requirements.map((requirement) => (
            <article key={requirement.id}>
              <strong>{requirement.statement}</strong>
              {requirement.semanticTags && requirement.semanticTags.length > 0 ? <small>Semantic tags: {requirement.semanticTags.join(" · ")}</small> : null}
              <ul>{requirement.acceptanceCriteria.map((criterion) => (
                <li key={`${criterion.id}:${criterion.version}`}>
                  {criterion.observableClaim} · {criterion.blocking ? "required" : "advisory"} · assurance {criterion.requiredAssurance.join(" + ")} · {criterion.verificationIntent.join(" · ")}
                </li>
              ))}</ul>
            </article>
          ))}
        </div>
      </InspectorSection>
      <InspectorSection title="Deliverables"><StringList values={contract.expectedArtifactRefs.map((ref) => describeContractDeliverable(ref, contract, libraryDetails))} /></InspectorSection>
      <InspectorSection title="Boundaries"><StringList values={contract.nonGoals} /></InspectorSection>
      <InspectorSection title="Assumptions / blocking inputs"><StringList values={[...contract.assumptions, ...contract.blockingInputs]} /></InspectorSection>
      <InspectorSection title="Risk / requested side effects"><StringList values={[...contract.riskTags.map(describeRiskTag), ...contract.requestedSideEffects.map(describeSideEffect)]} /></InspectorSection>
      <InspectorSection title="Effort / scope"><p>{scopeEffortDescription(contract)}</p></InspectorSection>
      <InspectorSection title="Coverage / evaluator evidence">
        <div data-testid="goal-contract-evaluator-evidence">
          <p>{mission.coverage.covered}/{mission.coverage.total} covered · {mission.evaluatorResults.length} evaluator results</p>
          <CoverageMatrix mission={mission} lineage={state.model.lineage ?? null} />
          <StringList values={[
            ...(mission.coverage.failedRequirementIds.length > 0
              ? [`failed requirements: ${mission.coverage.failedRequirementIds.join(", ")}`]
              : ["failed requirements: none"]),
            ...mission.coverage.entries.flatMap((entry) => [
              `${entry.requirementId} producers: ${entry.producerTaskIds.join(", ") || "none"}`,
              `${entry.requirementId} artifacts: ${entry.artifactRefs.join(", ") || "none"}`,
              `${entry.requirementId} artifact contracts: ${(entry.artifactContractRefs ?? []).join(", ") || "none"}`,
              `${entry.requirementId} evaluator tasks: ${entry.evaluatorTaskIds.join(", ") || "none"}`,
              `${entry.requirementId} evaluator profiles: ${entry.evaluatorProfileRefs.join(", ") || "none"}`,
              `${entry.requirementId} semantic tags: ${(entry.semanticTags ?? []).join(", ") || "legacy / not recorded"}`,
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
      {state.model.lineage?.chain ? <InspectorSection title="Unified completion lineage">
        <LineageChainSummary chain={state.model.lineage.chain} />
      </InspectorSection> : null}
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

function LineageChainSummary({ chain }: { chain: NonNullable<WorkflowLineageReadModel["chain"]> }) {
  const stages = [
    ["Goal", chain.goal.status, chain.goal.title ?? chain.goal.id],
    ["Requirements", `${chain.requirements.length}`, chain.requirements.filter((item) => item.status !== "missing").map((item) => item.id).join(", ") || "none"],
    ["Criteria", `${chain.criteria.length}`, chain.criteria.filter((item) => item.status === "passed").map((item) => item.id).join(", ") || "pending"],
    ["Checks", `${chain.checks.filter((item) => item.status === "passed").length}/${chain.checks.length}`, chain.checks.filter((item) => item.status !== "passed").map((item) => `${item.id} (${item.status})`).join(", ") || "all passed"],
    ["Bindings", `${chain.bindings.length}`, chain.bindings.map((item) => item.id).join(", ") || "none"],
    ["Slices", `${chain.slices.length}`, chain.slices.map((item) => item.outcome).join(" · ") || "none"],
    ["DAG / Tasks", `${chain.tasks.length}`, chain.dag ? `${chain.dag.id} · ${chain.dag.status}` : "not composed"],
    ["Producer / Artifact", `${chain.producers.length}/${chain.artifacts.length}`, chain.artifacts.map((item) => item.ref).join(", ") || "none"],
    ["Evidence / Evaluator", `${chain.evidence.length}/${chain.evaluators.length}`, chain.evidence.map((item) => item.ref).join(", ") || "awaiting evidence"],
    ["Completion", chain.completion.status, chain.completion.blockers.join(", ") || `${chain.completion.passedChecks}/${chain.completion.blockingChecks} blocking checks passed`],
  ] as const;
  return <div data-testid="goal-completion-lineage" style={{ display: "grid", gap: 6, marginTop: 8 }}>
    {stages.map(([label, status, detail]) => <div key={label} style={{ display: "grid", gridTemplateColumns: "145px 105px minmax(0, 1fr)", gap: 8, alignItems: "baseline", padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
      <strong>{label}</strong><span style={{ color: status === "blocked" || status === "failed" ? "var(--danger, #b42318)" : "var(--text-muted)" }}>{status}</span><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{detail}</span>
    </div>)}
  </div>;
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

type CoverageEntry = GoalMissionReadModel["coverage"]["entries"][number];

type CoverageRow = {
  entry: CoverageEntry;
  requirement: GoalMissionReadModel["goalContract"]["requirements"][number] | undefined;
  evidenceRefs: string[];
  evaluatorLabels: string[];
  status: "complete" | "pending" | "missing" | "missing-evidence" | "failed";
  reason: string;
};

type LineageSlice = NonNullable<WorkflowLineageReadModel["slicePlan"]>["slices"][number];
type LineageTask = WorkflowLineageReadModel["tasks"][number];

export function buildMissionCoverageGraph(mission: GoalMissionReadModel): { nodes: LibraryGraphChartNode[]; edges: LibraryGraphChartEdge[] } {
  const rows = mission.coverage.entries.map((entry) => coverageRow(entry, mission));
  return buildCoverageGraph(rows, mission, null);
}

function CoverageMatrix({ mission, lineage }: { mission: GoalMissionReadModel; lineage: WorkflowLineageReadModel | null }) {
  const rows = mission.coverage.entries.map((entry) => coverageRow(entry, mission));
  return (
    <div data-testid="goal-contract-coverage-matrix" style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1180, tableLayout: "fixed", fontSize: 12 }}>
          <colgroup>
            {["27%", "8%", "8%", "13%", "9%", "10%", "10%", "9%", "6%"].map((width, index) => <col key={index} style={{ width }} />)}
          </colgroup>
          <thead>
            <tr>
              {[
                "Requirement / AC",
                "Slice Plan",
                "Workflow DAG",
                "Task",
                "Producer",
                "Artifact",
                "Evidence",
                "Evaluator",
                "Coverage",
              ].map((label) => <th key={label} scope="col" style={coverageHeaderStyle}>{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const requirementLineage = lineageForRequirement(row.entry.requirementId, row.entry.producerTaskIds, lineage);
              return <tr key={row.entry.requirementId} data-testid={`goal-contract-coverage-row-${row.entry.requirementId}`}>
                <CoverageCell>
                  <strong>{row.requirement?.statement ?? row.entry.requirementId}</strong>
                  <span>{row.requirement?.acceptanceCriteria.map((criterion) => criterion.observableClaim).join(" · ") || "Acceptance criteria not recorded"}</span>
                  <small>{row.entry.requirementId}</small>
                </CoverageCell>
                <CoverageCell values={requirementLineage.sliceIds} />
                <CoverageCell values={requirementLineage.dag ? [requirementLineage.dag.id] : []} />
                <CoverageCell values={requirementLineage.tasks.map((task) => task.label)} extraValues={requirementLineage.tasks.map((task) => task.id)} />
                <CoverageCell values={row.entry.producerTaskIds} />
                <CoverageCell values={row.entry.artifactRefs} extraValues={row.entry.artifactContractRefs} />
                <CoverageCell values={row.evidenceRefs} extraValues={row.entry.requiredEvidenceKinds.map((kind) => `required: ${kind}`)} />
                <CoverageCell values={row.evaluatorLabels} />
                <td style={coverageCellStyle}>
                  <span style={{ color: coverageStatusColor(row.status), fontWeight: 700 }}>
                    {row.status === "complete" ? "✓ Complete" : row.status === "failed" ? "⛔ Failed" : row.status === "pending" ? "⏳ Awaiting runtime evidence" : row.status === "missing-evidence" ? "⚠ Missing runtime evidence" : "⚠ Missing design binding"}
                  </span>
                  <small style={{ display: "block", marginTop: 3, color: "var(--text-dim)" }}>{row.reason}</small>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
    </div>
  );
}

function CoverageCell({ children, values, extraValues = [] }: { children?: React.ReactNode; values?: string[]; extraValues?: string[] }) {
  const lines = [...(values ?? []), ...extraValues];
  return (
    <td style={coverageCellStyle}>
      {children ?? (lines.length > 0 ? lines.map((value, index) => <span key={`${value}:${index}`}>{value}</span>) : <span style={{ color: "var(--warning, #b54708)" }}>Not bound</span>)}
    </td>
  );
}

function coverageRow(entry: CoverageEntry, mission: GoalMissionReadModel): CoverageRow {
  const evidenceRefs = evidenceRefsFor(entry.requirementId, mission.evaluatorResults);
  const requirement = mission.goalContract.requirements.find((candidate) => candidate.id === entry.requirementId);
  const evaluatorLabels = uniqueSorted([
    ...entry.evaluatorTaskIds,
    ...entry.evaluatorProfileRefs,
  ]);
  const hasFailedResult = mission.coverage.failedRequirementIds.includes(entry.requirementId)
    || mission.evaluatorResults.some((result) => {
      const record = recordValue(result);
      return Array.isArray(record?.requirementIds)
        && record.requirementIds.includes(entry.requirementId)
        && stringValue(record.verdict)?.toLowerCase() === "failed";
    });
  const artifactBindingRefs = entry.artifactContractRefs ?? entry.artifactRefs;
  const designBindingComplete = entry.producerTaskIds.length > 0
    && artifactBindingRefs.length > 0
    && evaluatorLabels.length > 0
    && (!requirement?.blocking || entry.requiredEvidenceKinds.length > 0);
  const complete = designBindingComplete && evidenceRefs.length > 0;
  const executionTerminal = ["completed", "passed", "failed", "cancelled"].includes(mission.status.execution.toLowerCase());
  const status = hasFailedResult
    ? "failed"
    : complete
      ? "complete"
      : !designBindingComplete
        ? "missing"
        : executionTerminal
          ? "missing-evidence"
        : "pending";
  return {
    entry,
    requirement,
    evidenceRefs,
    evaluatorLabels,
    status,
    reason: status === "pending"
      ? "The producer and evaluator are bound; runtime output/evidence has not been recorded yet."
      : status === "missing-evidence"
        ? "Execution is terminal but the required runtime evidence is missing."
      : status === "missing"
        ? "Producer, artifact, evaluator, or required evidence binding is incomplete."
        : status === "failed"
          ? "The evaluator reported a failed requirement."
          : "The persisted artifact, evidence, and evaluator result are present.",
  };
}

function buildCoverageGraph(rows: CoverageRow[], mission: GoalMissionReadModel, lineage: WorkflowLineageReadModel | null): { nodes: LibraryGraphChartNode[]; edges: LibraryGraphChartEdge[] } {
  const nodes = new Map<string, LibraryGraphChartNode>();
  const edges: LibraryGraphChartEdge[] = [];
  const addNode = (objectKey: string, title: string, objectKind: string, status: string) => {
    if (!nodes.has(objectKey)) nodes.set(objectKey, { objectKey, title, objectKind, status });
  };
  const addEdge = (fromObjectKey: string, toObjectKey: string, edgeType: string) => {
    edges.push({ fromObjectKey, toObjectKey, edgeType });
  };

  for (const row of rows) {
    const requirementKey = `requirement:${row.entry.requirementId}`;
    const acceptanceKey = `ac:${row.entry.requirementId}`;
    const requirementTitle = row.requirement?.statement ?? row.entry.requirementId;
    const acceptanceTitle = row.requirement?.acceptanceCriteria.length
      ? `AC · ${row.requirement.acceptanceCriteria[0]!.observableClaim}${row.requirement.acceptanceCriteria.length > 1 ? ` (+${row.requirement.acceptanceCriteria.length - 1})` : ""}`
      : "Acceptance criteria missing";
    addNode(requirementKey, requirementTitle, "domain_taxonomy", row.status === "complete" ? "approved" : row.status === "failed" ? "blocked" : "draft");
    addNode(acceptanceKey, acceptanceTitle, "acceptance_criteria", row.status === "complete" ? "approved" : "draft");
    addEdge(requirementKey, acceptanceKey, "contains");

    const requirementLineage = lineageForRequirement(row.entry.requirementId, row.entry.producerTaskIds, lineage);
    const sliceKeys = requirementLineage.sliceIds.map((sliceId) => `slice:${sliceId}`);
    requirementLineage.slices.forEach((slice) => {
      addNode(`slice:${slice.id}`, `Slice Plan · ${slice.id}`, "slice_plan", graphStatusForLineage(row.status));
    });
    sliceKeys.forEach((sliceKey) => addEdge(acceptanceKey, sliceKey, "covered by"));

    const dagKey = requirementLineage.dag ? `dag:${requirementLineage.dag.id}` : null;
    if (requirementLineage.dag && dagKey) {
      addNode(dagKey, `Workflow DAG · ${requirementLineage.dag.id}`, "workflow_dag", graphStatusForLineage(row.status));
      sliceKeys.forEach((sliceKey) => addEdge(sliceKey, dagKey, "compiled to"));
      if (sliceKeys.length === 0) addEdge(acceptanceKey, dagKey, "compiled to");
    }

    const taskKeys = requirementLineage.tasks.map((task) => `task:${task.id}`);
    requirementLineage.tasks.forEach((task) => {
      const taskKey = `task:${task.id}`;
      addNode(taskKey, `Task · ${task.label}`, "workflow_task", graphStatusForLineage(task.status));
      if (dagKey) addEdge(dagKey, taskKey, "contains");
      else if (sliceKeys.length > 0) sliceKeys.forEach((sliceKey) => addEdge(sliceKey, taskKey, "executes"));
      else addEdge(acceptanceKey, taskKey, "executes");
    });

    const producerKeys = row.entry.producerTaskIds.map((taskId) => `producer:${taskId}`);
    if (producerKeys.length === 0) {
      producerKeys.push(`producer:missing:${row.entry.requirementId}`);
      addNode(producerKeys[0], "Producer · missing", "producer_task", "blocked");
    } else {
      row.entry.producerTaskIds.forEach((taskId) => addNode(`producer:${taskId}`, `Producer · ${taskId}`, "producer_task", "approved"));
    }
    if (taskKeys.length > 0) {
      taskKeys.forEach((taskKey) => producerKeys.forEach((producerKey) => addEdge(taskKey, producerKey, "uses producer")));
    } else {
      producerKeys.forEach((producerKey) => addEdge(acceptanceKey, producerKey, "implemented by"));
    }

    const artifactKeys = row.entry.artifactRefs.map((artifactRef) => `artifact:${artifactRef}`);
    if (artifactKeys.length === 0) {
      artifactKeys.push(`artifact:missing:${row.entry.requirementId}`);
      addNode(artifactKeys[0], "Artifact · missing", "artifact_contract", "blocked");
    } else {
      row.entry.artifactRefs.forEach((artifactRef) => addNode(`artifact:${artifactRef}`, `Artifact · ${artifactRef}`, "artifact_contract", "approved"));
    }
    producerKeys.forEach((producerKey) => artifactKeys.forEach((artifactKey) => addEdge(producerKey, artifactKey, "produces")));

    const evidenceKeys = row.evidenceRefs.map((evidenceRef) => `evidence:${evidenceRef}`);
    if (evidenceKeys.length === 0) {
      const requiredKinds = row.entry.requiredEvidenceKinds.length > 0 ? row.entry.requiredEvidenceKinds.join(" · ") : "not recorded";
      evidenceKeys.push(`evidence:missing:${row.entry.requirementId}`);
      addNode(evidenceKeys[0], `Evidence · ${requiredKinds}`, "evidence_packet", "blocked");
    } else {
      row.evidenceRefs.forEach((evidenceRef) => addNode(`evidence:${evidenceRef}`, `Evidence · ${evidenceRef}`, "evidence_packet", "approved"));
    }
    artifactKeys.forEach((artifactKey) => evidenceKeys.forEach((evidenceKey) => addEdge(artifactKey, evidenceKey, "proves")));

    const evaluatorKeys = row.evaluatorLabels.map((label) => `evaluator:${label}`);
    if (evaluatorKeys.length === 0) {
      evaluatorKeys.push(`evaluator:missing:${row.entry.requirementId}`);
      addNode(evaluatorKeys[0], "Evaluator · missing", "evaluator", "blocked");
    } else {
      row.evaluatorLabels.forEach((label) => addNode(`evaluator:${label}`, `Evaluator · ${label}`, "evaluator", "approved"));
    }
    [...artifactKeys, ...evidenceKeys].forEach((inputKey) => evaluatorKeys.forEach((evaluatorKey) => addEdge(inputKey, evaluatorKey, "evaluates")));

    const verdictKey = `verdict:${row.entry.requirementId}`;
    addNode(verdictKey, `Verdict · ${verdictFor(row, mission)}`, "verdict", row.status === "failed" ? "blocked" : row.status === "complete" ? "approved" : "draft");
    evaluatorKeys.forEach((evaluatorKey) => addEdge(evaluatorKey, verdictKey, "returns"));
  }
  return { nodes: [...nodes.values()], edges };
}

function lineageForRequirement(
  requirementId: string,
  producerTaskIds: string[],
  lineage: WorkflowLineageReadModel | null,
): { slices: LineageSlice[]; sliceIds: string[]; dag: WorkflowLineageReadModel["workflowDag"]; tasks: LineageTask[] } {
  if (!lineage) return { slices: [], sliceIds: [], dag: null, tasks: [] };
  const slices = lineage.slicePlan?.slices.filter((slice) => slice.requirementIds.includes(requirementId)) ?? [];
  const sliceIds = uniqueSorted([
    ...slices.map((slice) => slice.id),
    ...lineage.tasks
      .filter((task) => task.requirementIds.includes(requirementId) && task.sliceId)
      .map((task) => task.sliceId as string),
  ]);
  const tasks = lineage.tasks.filter((task) =>
    task.requirementIds.includes(requirementId)
      || producerTaskIds.includes(task.id)
      || (task.sliceId ? sliceIds.includes(task.sliceId) : false),
  );
  const dag = lineage.workflowDag && (sliceIds.length > 0 || tasks.length > 0) ? lineage.workflowDag : null;
  return { slices, sliceIds, dag, tasks };
}

function graphStatusForLineage(status: string): string {
  const normalized = status.toLowerCase();
  if (["failed", "blocked", "rejected", "invalid"].includes(normalized)) return "blocked";
  if (["completed", "satisfied", "passed", "ready", "active", "running"].includes(normalized)) return "approved";
  return "draft";
}

function evidenceRefsFor(requirementId: string, results: unknown[]): string[] {
  return uniqueSorted(results.flatMap((result) => {
    const record = recordValue(result);
    if (!record || !Array.isArray(record.requirementIds) || !record.requirementIds.includes(requirementId)) return [];
    return Array.isArray(record.evidenceRefs) ? record.evidenceRefs.filter((value): value is string => typeof value === "string") : [];
  }));
}

function verdictFor(row: CoverageRow, mission: GoalMissionReadModel): string {
  const verdict = mission.evaluatorResults
    .map(recordValue)
    .find((result) => Array.isArray(result?.requirementIds) && result.requirementIds.includes(row.entry.requirementId));
  return stringValue(verdict?.verdict) ?? "pending";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function coverageStatusColor(status: CoverageRow["status"]): string {
  return status === "complete"
    ? "var(--success, #0f766e)"
    : status === "failed"
      ? "var(--danger, #b42318)"
    : status === "pending"
        ? "var(--accent, #2563eb)"
        : "var(--warning, #b54708)";
}

const coverageHeaderStyle = { textAlign: "left", padding: "6px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", overflowWrap: "anywhere" } as const;
const coverageCellStyle = { verticalAlign: "top", padding: "7px 6px", borderBottom: "1px solid var(--border)", overflowWrap: "anywhere" } as const;

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
