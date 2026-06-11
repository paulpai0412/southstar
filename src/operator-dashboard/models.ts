import type { HostAdapterName } from "../config/schema.ts";
import type { HistoryEntry, IssueSnapshot, LifecycleState } from "../types/control-plane.ts";

export const northstarHostAdapters = ["codex", "opencode", "pi"] as const satisfies readonly HostAdapterName[];
export const northstarWizardPhases = ["plan", "setup", "execute", "monitor", "recovery", "report"] as const;
export type NorthstarWizardPhase = typeof northstarWizardPhases[number];

export type OperatorActionName = "intake" | "start" | "reconcile" | "release" | "repair-runtime" | "retry-sync" | "resume" | "inspect";
export interface NorthstarOperatorActionDescriptor {
  action: OperatorActionName;
  label: string;
  requiresConfirmation: boolean;
  style: "primary" | "secondary" | "danger";
}
export type WizardActionName =
  | "select_phase"
  | "generate_command_plan"
  | "approve_gate"
  | "reject_gate"
  | "run_phase_action";

export interface NorthstarProjectCapabilities {
  hostAdapters: readonly HostAdapterName[];
  optionalParameters: readonly ("skill" | "model")[];
  mcpServers: {
    status: "design_only";
    configurable: false;
    supported: false;
  };
}

export const defaultNorthstarProjectCapabilities: NorthstarProjectCapabilities = {
  hostAdapters: northstarHostAdapters,
  optionalParameters: ["skill", "model"],
  mcpServers: {
    status: "design_only",
    configurable: false,
    supported: false,
  },
};

export interface NorthstarProjectSummary {
  projectId: string;
  name: string;
  root: string;
  repo: string;
  hostAdapter: HostAdapterName;
  configPath: string;
  runtimeDbPath: string;
  capabilities: NorthstarProjectCapabilities;
}

export interface NorthstarBoard {
  project: NorthstarProjectSummary;
  groups: NorthstarBoardGroup[];
}

export interface NorthstarBoardGroup {
  lifecycle: LifecycleState;
  cards: NorthstarBoardCard[];
}

export interface NorthstarBoardCard {
  issueId: string;
  issueNumber: string | null;
  title: string;
  lifecycle: LifecycleState;
  currentStage: string | null;
  latestHostAdapter: HostAdapterName | null;
  dependencyCount: number;
  blocked: boolean;
  prUrl: string | null;
  mergeSha: string | null;
  latestRootSessionId: string | null;
  latestChildRunId: string | null;
  activeStreamAdapter: HostAdapterName | null;
  activeStreamSessionId: string | null;
  activeStreamChildRunId: string | null;
  lastHeartbeatAt: string | null;
  nextRecommendedAction: string;
  projectionFailure: boolean;
}

export interface NorthstarIssueDetail {
  snapshot: IssueSnapshot;
  title: string;
  sourceUrl: string | null;
  labels: string[];
  inspect: Record<string, unknown>;
  timeline: NorthstarRunEvent[];
  sessionLinks: NorthstarSessionLink[];
  acceptedArtifacts: NorthstarArtifactSummary[];
  availableActions: NorthstarOperatorActionDescriptor[];
}

export interface NorthstarRunEvent {
  id: string;
  sequence: number;
  eventType: string;
  severity: "info" | "warning" | "error";
  createdAt: string | null;
  summary: string;
  payloadPreview: unknown;
}

export interface NorthstarSessionLink {
  host: HostAdapterName;
  rootSessionId: string;
  childRunId: string;
  sessionId: string;
  streamAdapter: HostAdapterName | null;
  streamSessionId: string | null;
  href: string | null;
}

export interface NorthstarArtifactSummary {
  historyId: number;
  artifactHistoryId: number;
  artifact_history_id: unknown;
  kind: string;
  summary: string;
}

export interface NorthstarWizardState {
  projectId: string;
  currentPhase: NorthstarWizardPhase;
  phases: NorthstarWizardPhaseState[];
  selectedOptions: Record<string, unknown>;
  commandPlans: NorthstarCommandPlan[];
  confirmationGates: NorthstarConfirmationGate[];
  evidence: NorthstarWizardEvidence[];
  nextRecommendedAction: string | null;
}

export interface NorthstarWizardPhaseState {
  phase: NorthstarWizardPhase;
  status: "not_started" | "ready" | "waiting_for_confirmation" | "running" | "completed" | "blocked";
  summary: string;
  requiredInputs: string[];
  completedChecks: string[];
  blockers: string[];
}

export interface NorthstarCommandPlan {
  id: string;
  phase: NorthstarWizardPhase;
  description: string;
  argv: string[];
  expectedEffects: string[];
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
}

export interface NorthstarConfirmationGate {
  id: string;
  phase: NorthstarWizardPhase;
  title: string;
  reason: string;
  commandPlanIds: string[];
  status: "open" | "approved" | "rejected";
}

export interface NorthstarWizardEvidence {
  phase: NorthstarWizardPhase;
  kind: "doctor" | "config" | "github" | "project" | "runtime" | "verification" | "recovery" | "report";
  summary: string;
  links: Array<{ label: string; url: string }>;
  payloadPreview: unknown;
}

export type ResumeTargetLifecycle = "ready" | "running";

export interface OperatorActionRequest {
  action: OperatorActionName;
  issueId: string;
  confirmed?: boolean;
  reason?: string;
  targetLifecycle?: ResumeTargetLifecycle;
}

export interface OperatorActionResponse {
  action: OperatorActionName;
  result: unknown;
  updatedIssue?: NorthstarIssueDetail;
  nextRecommendedAction: string | null;
}

export interface WizardActionRequest {
  action: WizardActionName;
  phase?: NorthstarWizardPhase;
  gateId?: string;
  commandPlanId?: string;
  issueId?: string;
  options?: Record<string, unknown>;
  confirmed?: boolean;
}

export interface WizardActionResponse {
  state: NorthstarWizardState;
  actionResult?: unknown;
}

export interface DashboardReadInput {
  project: NorthstarProjectSummary;
  issues: IssueSnapshot[];
  historiesByIssueId: Map<string, HistoryEntry[]>;
  now: string;
}
