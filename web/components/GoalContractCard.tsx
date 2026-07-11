"use client";

import type { GoalMissionReadModel, WorkflowCommandDescriptor } from "@/lib/workflow/types";

export function GoalContractCard({
  mission,
  runStatus,
  approvalCommand,
  onOpenDetails,
  onReviseGoal,
  onApprove,
  approvalPending = false,
}: {
  mission: GoalMissionReadModel;
  runStatus?: "awaiting_approval" | "scheduling";
  approvalCommand?: WorkflowCommandDescriptor;
  onOpenDetails: () => void;
  onReviseGoal: (choice?: string) => void;
  onApprove: (command: WorkflowCommandDescriptor) => void;
  approvalPending?: boolean;
}) {
  const contract = mission.goalContract;
  const acceptanceCriteria = contract.requirements.flatMap((requirement) => requirement.acceptanceCriteria).slice(0, 3);
  return (
    <section data-testid="goal-contract-card" className="goal-contract-card">
      <header className="goal-contract-card-header">
        <div>
          <span className="goal-contract-eyebrow">Goal Contract</span>
          <strong data-testid="goal-contract-summary">{contract.summary}</strong>
        </div>
        <span data-testid="goal-coverage-count">{mission.coverage.covered}/{mission.coverage.total} covered</span>
      </header>
      <div className="goal-contract-card-grid">
        <GoalFact label="Workspace" values={[contract.workspace.cwd, contract.domain]} />
        <GoalFact label="Acceptance" values={acceptanceCriteria} />
        <GoalFact label="Deliverables" values={contract.expectedArtifactRefs} />
        <GoalFact label="Assumptions" values={contract.assumptions} />
        <GoalFact label="Risk / effects" values={[...contract.riskTags, ...contract.requestedSideEffects]} />
      </div>
      {contract.blockingInputs.length > 0 ? (
        <div className="goal-contract-blocking" data-testid="goal-contract-clarifications">
          <strong>Needs input</strong>
          <div className="goal-contract-choice-list">
            {contract.blockingInputs.map((choice) => <button type="button" key={choice} onClick={() => onReviseGoal(choice)}>{choice}</button>)}
          </div>
        </div>
      ) : null}
      <div className="goal-contract-status-row">
        <Status label="Execution" value={mission.status.execution} />
        <Status label="Outcome" value={mission.status.outcome} />
        <Status label="Health" value={mission.status.health} />
        {runStatus === "scheduling" ? <span className="goal-contract-note">Scheduled automatically</span> : null}
        {runStatus === "awaiting_approval" && approvalCommand ? (
          <button
            type="button"
            data-testid="goal-contract-approve"
            disabled={!approvalCommand.enabled || approvalPending}
            onClick={() => onApprove(approvalCommand)}
          >
            {approvalCommand.label}
          </button>
        ) : null}
      </div>
      <footer className="goal-contract-actions">
        <button type="button" onClick={() => onReviseGoal()}>Revise goal</button>
        <button type="button" data-testid="goal-contract-open-details" onClick={onOpenDetails}>View details</button>
      </footer>
    </section>
  );
}

function GoalFact({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="goal-contract-fact">
      <span>{label}</span>
      <p>{values.length > 0 ? values.join(" · ") : "None"}</p>
    </div>
  );
}

function Status({ label, value }: { label: string; value: string }) {
  return <span className="goal-contract-status"><small>{label}</small>{value}</span>;
}
