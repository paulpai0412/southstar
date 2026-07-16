export type GoalJourneyStage = "chat" | "requirements" | "library" | "workflow" | "operator" | "complete";
export type GoalJourneyMode = "chat" | "workflow" | "library" | "operator";

export type GoalJourneyLink = {
  id: string;
  title: string;
  currentStage?: GoalJourneyStage;
  chatSessionId?: string;
  workflowSessionId?: string;
  librarySessionId?: string;
  runId?: string;
};

export type GoalJourneyStep = {
  id: GoalJourneyStage;
  label: string;
  description: string;
  status: "complete" | "current" | "pending";
  mode: GoalJourneyMode;
  sessionId?: string;
  runId?: string;
};

export type GoalJourney = {
  id: string;
  title: string;
  currentStage: GoalJourneyStage;
  steps: GoalJourneyStep[];
};

const STAGES: Array<Pick<GoalJourneyStep, "id" | "label" | "description" | "mode">> = [
  { id: "chat", label: "Chat", description: "Goal intake", mode: "chat" },
  { id: "requirements", label: "Requirements", description: "Goal contract", mode: "workflow" },
  { id: "library", label: "Library", description: "Import and coverage", mode: "library" },
  { id: "workflow", label: "Workflow", description: "DAG plan", mode: "workflow" },
  { id: "operator", label: "Operator", description: "Run and evaluate", mode: "operator" },
  { id: "complete", label: "Complete", description: "Goal outcome", mode: "operator" },
];

export function buildGoalJourney(link: GoalJourneyLink): GoalJourney {
  const currentStage = link.currentStage ?? "chat";
  const currentIndex = STAGES.findIndex((stage) => stage.id === currentStage);
  const stageIndex = currentIndex < 0 ? 0 : currentIndex;

  return {
    id: link.id,
    title: link.title,
    currentStage,
    steps: STAGES.map((stage, index) => ({
      ...stage,
      status: currentStage === "complete"
        ? "complete"
        : index < stageIndex ? "complete" : index === stageIndex ? "current" : "pending",
      ...(stage.id === "chat" ? { sessionId: link.chatSessionId } : {}),
      ...(stage.id === "requirements" || stage.id === "workflow" ? { sessionId: link.workflowSessionId } : {}),
      ...(stage.id === "library" ? { sessionId: link.librarySessionId } : {}),
      ...(stage.id === "operator" || stage.id === "complete" ? { runId: link.runId } : {}),
    })),
  };
}
