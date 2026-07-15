import type { RuntimeServerContext } from "./runtime-context.ts";
import { handleArtifactRoute } from "./artifact-routes.ts";
import { handleChatRoute } from "./chat-routes.ts";
import { handleEvolutionRoute } from "./evolution-routes.ts";
import { handleExecutionRoute } from "./execution-routes.ts";
import { handleLibraryRoute } from "./library-routes.ts";
import { handleMemoryRoute } from "./memory-routes.ts";
import { handlePlannerRoute } from "./planner-routes.ts";
import { handleRunLifecycleRoute } from "./run-lifecycle-routes.ts";
import { handleRunReadRoute } from "./run-read-routes.ts";
import { handleSessionRoute } from "./session-routes.ts";
import { handleTaskCommandRoute } from "./task-command-routes.ts";
import { handleUiRoute } from "./ui-routes.ts";
import { handleWorkflowTemplateRoute } from "./workflow-template-routes.ts";

/**
 * Dispatches route families that already own their business rules.
 *
 * Keeping this ordered list outside the runtime route function makes route
 * precedence explicit and prevents the top-level HTTP handler from growing
 * another set of domain branches whenever a family is added.
 */
export async function dispatchRouteFamilies(
  context: RuntimeServerContext,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  const handlers = [
    handleEvolutionRoute,
    handleUiRoute,
    handleRunLifecycleRoute,
    handleSessionRoute,
    handleMemoryRoute,
    handleChatRoute,
    handleLibraryRoute,
    handleWorkflowTemplateRoute,
    handleArtifactRoute,
    handleExecutionRoute,
    handleTaskCommandRoute,
    handlePlannerRoute,
    handleRunReadRoute,
  ] as const;
  for (const handler of handlers) {
    const response = await handler(context, request, url);
    if (response) return response;
  }
  return undefined;
}
