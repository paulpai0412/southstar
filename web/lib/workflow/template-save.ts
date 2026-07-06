import type { WorkflowDag } from "./types";

export type WorkflowTemplateSaveRequest = {
  url: string;
  body: {
    scope: string;
    templateId: string;
    title: string;
    status: "approved";
  };
};

export function buildWorkflowTemplateSaveRequest(input: {
  draftId: string;
  dag: WorkflowDag;
  scope?: string;
  title?: string;
}): WorkflowTemplateSaveRequest {
  const title = input.title?.trim() || input.dag.templateTitle || "Saved Workflow Template";
  return {
    url: `/api/workflow/planner-drafts/${encodeURIComponent(input.draftId)}/save-template`,
    body: {
      scope: input.scope ?? "software",
      templateId: `template.${toTemplateSlug(input.dag.id ?? input.draftId)}`,
      title,
      status: "approved",
    },
  };
}

function toTemplateSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^template\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "generated";
}
