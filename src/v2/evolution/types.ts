export type LearningNodeType =
  | "run"
  | "task"
  | "session_checkpoint"
  | "context_packet"
  | "artifact"
  | "evaluator_result"
  | "repair_attempt"
  | "failure_kind"
  | "learning_signal"
  | "knowledge_card"
  | "delta_proposal"
  | "prompt_version"
  | "skill_version"
  | "agent_profile_version"
  | "flow_policy_version"
  | "sandbox_experiment"
  | "promotion"
  | "rollback";

export type LearningEdgeType =
  | "USED_PROFILE"
  | "USED_PROMPT"
  | "USED_SKILL"
  | "INJECTED_CARD"
  | "PRODUCED"
  | "EVALUATED_BY"
  | "FOUND_FAILURE"
  | "FIXED_FAILURE"
  | "DERIVED_FROM"
  | "SUPPORTED_BY"
  | "BASED_ON"
  | "TESTED"
  | "PROMOTED_TO"
  | "SUPERSEDES"
  | "ROLLED_BACK_TO"
  | "HELPED"
  | "HURT"
  | "CONFLICTS_WITH";

export type GraphReadModel = {
  centerNodeId: string;
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    status?: string;
    summary?: string;
    payload?: unknown;
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    type: string;
    weight?: number;
  }>;
};

export type WikiLinkRelation =
  | "supports"
  | "contradicts"
  | "supersedes"
  | "derived_from"
  | "used_by"
  | "improved"
  | "regressed"
  | "related_topic"
  | "same_as"
  | "broader_than"
  | "narrower_than";

export type WikiLinkStatus = "proposed" | "active" | "rejected" | "stale" | "superseded";

export type WikiLinkReadModel = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: WikiLinkRelation;
  status: WikiLinkStatus;
  confidence: number;
  reason: string;
  evidenceNodeRefs: string[];
  createdAt: string;
};

export type WikiPageReadModel = {
  nodeId: string;
  nodeType: LearningNodeType;
  title: string;
  summary: string;
  status: string;
  topicKey?: string;
  aliases: string[];
  forwardLinks: WikiLinkReadModel[];
  backlinks: WikiLinkReadModel[];
  evidenceLinks: WikiLinkReadModel[];
  runtimeUsageLinks: WikiLinkReadModel[];
  downstreamImpactLinks: WikiLinkReadModel[];
  conflictLinks: WikiLinkReadModel[];
  supersessionLinks: WikiLinkReadModel[];
};

export type KnowledgeCard = {
  cardType: "failure_lesson" | "success_pattern" | "profile_lesson" | "flow_lesson" | "preference" | "domain_pattern";
  topicKey: string;
  scope: string;
  title: string;
  summary: string;
  appliesTo: {
    intents?: string[];
    roles?: string[];
    artifactTypes?: string[];
    agentProfiles?: string[];
    promptTemplates?: string[];
    skills?: string[];
    flowTemplates?: string[];
  };
  claims: Array<{ text: string; evidenceNodeRefs: string[] }>;
  confidence: number;
  successScore: number;
  status: "candidate" | "active" | "pending_approval" | "stale" | "superseded" | "rejected" | "do_not_inject";
  riskTier: "low" | "medium" | "high";
};

export type DeltaProposal = {
  id: string;
  deltaKind: "knowledge_card_delta" | "prompt_delta" | "skill_delta" | "agent_profile_delta" | "flow_delta";
  targetRef?: string;
  targetVersion?: string;
  sourceCardRefs: string[];
  sourceNodeRefs: string[];
  evidenceSubgraphHash: string;
  hypothesis: string;
  patch: unknown;
  riskTier: "low" | "medium" | "high";
  validationPlan: {
    regressionSuiteRefs: string[];
    replayRunRefs: string[];
    maxCostRegressionPercent: number;
    maxDurationRegressionPercent: number;
    minReplayFixRate?: number;
  };
  rollbackPlan: {
    previousVersionRef?: string;
    strategy: "revert-version" | "disable-delta" | "manual";
  };
  status: "proposed" | "validating" | "validated" | "rejected" | "promoted" | "rolled_back";
};

export type AssetVersion = {
  id: string;
  assetKind: "prompt_template" | "skill" | "agent_profile" | "flow_policy";
  assetRef: string;
  version: string;
  parentVersion?: string;
  contentHash: string;
  payload: unknown;
  status: "candidate" | "active" | "canary" | "superseded" | "rolled_back" | "rejected";
  promotedByDeltaId?: string;
  createdAt: string;
};

export type SandboxExperiment = {
  id: string;
  deltaProposalId: string;
  status: "queued" | "materializing" | "running" | "evaluating" | "passed" | "failed" | "cancelled";
  baselineAssetRefs: string[];
  candidateAssetRefs: string[];
  regressionSuiteRefs: string[];
  replayRunRefs: string[];
};
