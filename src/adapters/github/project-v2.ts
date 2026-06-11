import { redactSecrets } from "../../runtime/redaction.ts";
import type { LifecycleState } from "../../types/control-plane.ts";

export const lifecycleStatusByState: Record<LifecycleState, string> = {
  ready: "Todo",
  claimed: "In Progress",
  running: "In Progress",
  verifying: "In Review",
  verified: "Ready to Release",
  release_pending: "Pending Release Approval",
  releasing: "Releasing",
  exception: "Blocked",
  completed: "Done",
  cancelled: "Cancelled",
  failed: "Failed",
  quarantined: "Blocked",
};

export function projectStatusForLifecycle(lifecycleState: string): { lifecycle: string; status: string } {
  const status = lifecycleStatusByState[lifecycleState as LifecycleState];
  if (!status) {
    throw new Error(`GitHub Project sync cannot map lifecycle "${lifecycleState}" to Status`);
  }
  return { lifecycle: lifecycleState, status };
}

export interface GitHubProjectV2ClientOptions {
  repo: string;
  projectId: string;
  token: string;
  fetch?: typeof fetch;
}

export interface GitHubProjectV2SyncInput {
  issueNumber: number;
  lifecycle?: string;
  prUrl?: string;
  mergeSha?: string;
  currentStage?: string;
  lastError?: string;
  retryCount?: number | string;
  blockedBy?: string;
  fields?: Record<string, unknown>;
}

export interface GitHubProjectV2Metrics {
  github_project_items_synced: number;
  github_project_status_done: number;
  github_project_lifecycle_completed: number;
  github_project_pr_urls_synced: number;
  github_project_merge_shas_synced: number;
  github_project_status_mismatches: number;
}

interface ProjectField {
  id: string;
  name: string;
  dataType?: string;
  options?: Array<{ id?: string; name: string; color?: string; description?: string }>;
}

interface FieldDiscovery {
  fieldsByName: Map<string, ProjectField>;
}

export class GitHubProjectV2Client {
  private readonly owner: string;
  private readonly name: string;
  private readonly projectId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private fieldDiscovery?: FieldDiscovery;

  constructor(options: GitHubProjectV2ClientOptions) {
    const [owner, name] = options.repo.split("/");
    if (!owner || !name) {
      throw new Error("GitHub Project sync requires repo in owner/name format");
    }
    this.owner = owner;
    this.name = name;
    this.projectId = options.projectId;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async syncIssueFields(input: GitHubProjectV2SyncInput): Promise<GitHubProjectV2Metrics> {
    const itemId = await this.ensureIssueProjectItemId(input.issueNumber);
    const fields = await this.discoverFields();
    const normalized = normalizeInput(input);
    const updates: Array<{ fieldName: string; value: unknown; kind: "single_select" | "scalar" }> = [];

    if (normalized.lifecycle) {
      const { lifecycle, status } = projectStatusForLifecycle(normalized.lifecycle);
      const projectedStatus = normalized.status ?? status;
      updates.push({ fieldName: "Northstar Lifecycle", value: lifecycle, kind: "single_select" });
      updates.push({ fieldName: "Status", value: projectedStatus, kind: "single_select" });
    }

    pushProvided(updates, "PR URL", normalized.prUrl);
    pushProvided(updates, "Merge SHA", normalized.mergeSha);
    pushProvided(updates, "Current Stage", normalized.currentStage);
    pushProvided(updates, "Last Error", normalized.lastError, { allowEmpty: true });
    pushProvided(updates, "Retry Count", normalized.retryCount);
    pushProvided(updates, "Blocked By", normalized.blockedBy, { allowEmpty: true });

    for (const update of updates) {
      const field = fieldForUpdate(fields.fieldsByName, update.fieldName);
      if (!field) {
        throw new Error(`GitHub Project sync missing required Project field "${update.fieldName}"`);
      }
      await this.updateField(itemId, field, update.value, update.kind);
    }

    const lifecycleStatus = normalized.lifecycle ? projectStatusForLifecycle(normalized.lifecycle).status : undefined;
    const expectedStatus = normalized.status ?? lifecycleStatus;
    return {
      github_project_items_synced: 1,
      github_project_status_done: expectedStatus === "Done" ? 1 : 0,
      github_project_lifecycle_completed: normalized.lifecycle === "completed" ? 1 : 0,
      github_project_pr_urls_synced: normalized.prUrl === undefined ? 0 : 1,
      github_project_merge_shas_synced: normalized.mergeSha === undefined ? 0 : 1,
      github_project_status_mismatches: normalized.status && lifecycleStatus && normalized.status !== expectedStatus ? 1 : 0,
    };
  }

  private async ensureIssueProjectItemId(issueNumber: number): Promise<string> {
    const data = await this.graphql<{
      repository?: {
        issue?: {
          id?: string;
          projectItems?: {
            nodes?: Array<{ id?: string; project?: { id?: string } | null } | null>;
          };
        } | null;
      } | null;
    }>(`
      query IssueProjectItem($owner: String!, $name: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $name) {
          issue(number: $issueNumber) {
            id
            projectItems(first: 100) {
              nodes {
                id
                project {
                  id
                }
              }
            }
          }
        }
      }
    `, { owner: this.owner, name: this.name, issueNumber });

    const issue = data.repository?.issue;
    if (!issue) {
      throw new Error(`GitHub Project sync could not find issue #${issueNumber} in ${this.owner}/${this.name}`);
    }
    const item = issue.projectItems?.nodes?.find((node) => node?.project?.id === this.projectId);
    if (item?.id) {
      return item.id;
    }
    if (!issue.id) {
      throw new Error(`GitHub Project sync could not discover issue node id for issue #${issueNumber}`);
    }
    return await this.addIssueToProject(issue.id);
  }

  private async addIssueToProject(contentId: string): Promise<string> {
    const data = await this.graphql<{
      addProjectV2ItemById?: {
        item?: { id?: string } | null;
      } | null;
    }>(`
      mutation AddIssueToProject($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {
          projectId: $projectId
          contentId: $contentId
        }) {
          item {
            id
          }
        }
      }
    `, { projectId: this.projectId, contentId });

    const itemId = data.addProjectV2ItemById?.item?.id;
    if (!itemId) {
      throw new Error("GitHub Project sync could not add issue to configured Project");
    }
    return itemId;
  }

  private async discoverFields(): Promise<FieldDiscovery> {
    if (this.fieldDiscovery) {
      return this.fieldDiscovery;
    }

    const data = await this.graphql<{
      node?: {
        id?: string;
        fields?: {
          nodes?: Array<ProjectField | null>;
        };
      } | null;
    }>(`
      query ProjectFields($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            id
            fields(first: 100) {
              nodes {
                __typename
                ... on ProjectV2Field {
                  id
                  name
                  dataType
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                    color
                    description
                  }
                }
              }
            }
          }
        }
      }
    `, { projectId: this.projectId });

    if (data.node?.id !== this.projectId) {
      throw new Error("GitHub Project sync could not discover configured Project fields");
    }

    const fieldsByName = new Map<string, ProjectField>();
    for (const field of data.node.fields?.nodes ?? []) {
      if (field?.id && field.name) {
        fieldsByName.set(field.name, field);
      }
    }

    this.fieldDiscovery = { fieldsByName };
    return this.fieldDiscovery;
  }

  private async updateField(
    itemId: string,
    field: ProjectField,
    rawValue: unknown,
    kind: "single_select" | "scalar",
  ): Promise<void> {
    const value = kind === "single_select"
      ? { singleSelectOptionId: await this.optionIdFor(field, String(rawValue)) }
      : scalarProjectValue(field, rawValue);

    await this.graphql<{
      updateProjectV2ItemFieldValue?: { projectV2Item?: { id?: string } | null } | null;
    }>(`
      mutation UpdateProjectField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: $value
        }) {
          projectV2Item {
            id
          }
        }
      }
    `, {
      projectId: this.projectId,
      itemId,
      fieldId: field.id,
      value,
    });
  }

  private async optionIdFor(field: ProjectField, optionName: string): Promise<string> {
    const existing = optionFor(field, optionName);
    if (existing?.id) {
      return existing.id;
    }
    if (isRepairableSingleSelectOption(field.name, optionName)) {
      const repaired = await this.repairMissingSingleSelectOption(field, optionName);
      if (repaired?.id) {
        return repaired.id;
      }
    }
    throw new Error(`GitHub Project sync missing option "${optionName}" for Project field "${field.name}"`);
  }

  private async repairMissingSingleSelectOption(
    field: ProjectField,
    optionName: string,
  ): Promise<{ id?: string; name: string } | undefined> {
    const existingOptions = field.options ?? [];
    const singleSelectOptions = [
      ...existingOptions.map((option) => ({
        ...(option.id ? { id: option.id } : {}),
        name: option.name,
        color: option.color ?? projectOptionColor(field.name, option.name),
        description: option.description ?? "",
      })),
      {
        name: optionName,
        color: projectOptionColor(field.name, optionName),
        description: projectOptionDescription(field.name, optionName),
      },
    ];

    const data = await this.graphql<{
      updateProjectV2Field?: {
        projectV2Field?: ProjectField | null;
      } | null;
    }>(`
      mutation RepairProjectSingleSelectOption($fieldId: ID!, $singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(input: {
          fieldId: $fieldId
          singleSelectOptions: $singleSelectOptions
        }) {
          projectV2Field {
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
                color
                description
              }
            }
          }
        }
      }
    `, {
      fieldId: field.id,
      singleSelectOptions,
    });

    const updatedField = data.updateProjectV2Field?.projectV2Field;
    if (updatedField?.options) {
      field.options = updatedField.options;
    } else {
      this.fieldDiscovery = undefined;
      const refreshed = await this.discoverFields();
      const refreshedField = refreshed.fieldsByName.get(field.name);
      if (refreshedField?.options) {
        field.options = refreshedField.options;
      }
    }
    return optionFor(field, optionName);
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(redactProjectError(`GitHub Project GraphQL HTTP ${response.status}: ${text}`));
    }

    let payload: { data?: T; errors?: Array<{ message?: string }> };
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(redactProjectError(`GitHub Project GraphQL returned invalid JSON: ${text}`));
    }

    if (payload.errors?.length) {
      throw new Error(redactProjectError(`GitHub Project GraphQL failed: ${payload.errors.map((error) => error.message ?? "unknown error").join("; ")}`));
    }
    if (!payload.data) {
      throw new Error("GitHub Project GraphQL returned no data");
    }
    return payload.data;
  }
}

function normalizeInput(input: GitHubProjectV2SyncInput) {
  const fields = input.fields ?? {};
  return {
    lifecycle: stringFrom(input.lifecycle ?? pick(fields, "lifecycle", "Lifecycle", "Northstar Lifecycle")),
    status: stringFrom(pick(fields, "status", "Status")),
    prUrl: stringFrom(input.prUrl ?? pick(fields, "pr_url", "prUrl", "PR URL", "PR")),
    mergeSha: stringFrom(input.mergeSha ?? pick(fields, "merge_sha", "mergeSha", "Merge SHA")),
    currentStage: stringFrom(input.currentStage ?? pick(fields, "current_stage", "currentStage", "Current Stage")),
    lastError: stringFromAllowEmpty(input.lastError ?? pickIncludingEmpty(fields, "last_error", "lastError", "Last Error")),
    retryCount: input.retryCount ?? pick(fields, "retry_count", "retryCount", "Retry Count"),
    blockedBy: stringFromAllowEmpty(input.blockedBy ?? pickIncludingEmpty(fields, "blocked_by", "blockedBy", "Blocked By")),
  };
}

function pick(fields: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (fields[key] !== undefined && fields[key] !== null && fields[key] !== "") {
      return fields[key];
    }
  }
  return undefined;
}

function pickIncludingEmpty(fields: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (fields[key] !== undefined && fields[key] !== null) {
      return fields[key];
    }
  }
  return undefined;
}

function stringFrom(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return String(value);
}

function stringFromAllowEmpty(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function pushProvided(
  updates: Array<{ fieldName: string; value: unknown; kind: "single_select" | "scalar" }>,
  fieldName: string,
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): void {
  if (value !== undefined && value !== null && (options.allowEmpty || value !== "")) {
    updates.push({ fieldName, value, kind: "scalar" });
  }
}

function fieldForUpdate(fieldsByName: Map<string, ProjectField>, fieldName: string): ProjectField | undefined {
  for (const candidate of fieldAliases(fieldName)) {
    const field = fieldsByName.get(candidate);
    if (field) {
      return field;
    }
  }
  return undefined;
}

function isRepairableSingleSelectOption(fieldName: string, optionName: string): boolean {
  if (fieldName === "Northstar Lifecycle") {
    return lifecycleStates().has(optionName);
  }
  if (fieldName === "Status") {
    return lifecycleStatuses().has(optionName);
  }
  return false;
}

function fieldAliases(fieldName: string): string[] {
  const aliases: Record<string, string[]> = {
    "PR URL": ["PR URL", "Northstar PR"],
    "Merge SHA": ["Merge SHA", "Northstar Merge SHA"],
    "Blocked By": ["Blocked By", "Northstar Blocked By"],
  };
  return aliases[fieldName] ?? [fieldName];
}

function optionFor(field: ProjectField, optionName: string): { id: string; name: string } | undefined {
  const options = field.options ?? [];
  const exact = options.find((item) => item.name === optionName);
  if (exact) {
    return exact;
  }
  const normalizedOptionName = normalizeOptionName(optionName);
  const normalized = options.find((item) => normalizeOptionName(item.name) === normalizedOptionName);
  if (normalized) {
    return normalized;
  }
  for (const candidate of optionAliases(optionName)) {
    const option = options.find((item) => normalizeOptionName(item.name) === normalizeOptionName(candidate));
    if (option) {
      return option;
    }
  }
  return undefined;
}

function optionAliases(optionName: string): string[] {
  const aliases: Record<string, string[]> = {
    Todo: ["Ready", "Backlog"],
    "In Progress": ["In progress"],
    "In Review": ["In review"],
    "Ready to Release": ["In review"],
    "Pending Release Approval": ["Ready to Release", "In review"],
    Releasing: ["In review"],
    Failed: ["Backlog"],
    Blocked: ["Backlog"],
  };
  return aliases[optionName] ?? [];
}

function normalizeOptionName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function projectOptionColor(fieldName: string, optionName: string): string {
  const lifecycleColors: Record<string, string> = {
    ready: "GRAY",
    claimed: "YELLOW",
    running: "YELLOW",
    verifying: "PURPLE",
    verified: "GREEN",
    release_pending: "ORANGE",
    releasing: "ORANGE",
    completed: "GREEN",
    cancelled: "GRAY",
    failed: "RED",
    quarantined: "RED",
  };
  const statusColors: Record<string, string> = {
    Todo: "GRAY",
    "In Progress": "YELLOW",
    "In Review": "PURPLE",
    "Ready to Release": "GREEN",
    "Pending Release Approval": "ORANGE",
    Releasing: "ORANGE",
    Done: "GREEN",
    Cancelled: "GRAY",
    Failed: "RED",
    Blocked: "RED",
  };
  if (fieldName === "Northstar Lifecycle") return lifecycleColors[optionName] ?? "GRAY";
  if (fieldName === "Status") return statusColors[optionName] ?? "GRAY";
  return "GRAY";
}

function projectOptionDescription(fieldName: string, optionName: string): string {
  if (fieldName === "Northstar Lifecycle") return `Northstar runtime lifecycle: ${optionName}`;
  if (fieldName === "Status") return `Northstar projected status: ${optionName}`;
  return "";
}

function lifecycleStates(): Set<string> {
  return new Set(Object.keys(lifecycleStatusByState));
}

function lifecycleStatuses(): Set<string> {
  return new Set(Object.values(lifecycleStatusByState));
}

function scalarProjectValue(field: ProjectField, rawValue: unknown): { text: string } | { number: number } {
  if (field.dataType === "NUMBER") {
    const number = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isFinite(number)) {
      throw new Error(`GitHub Project sync field "${field.name}" requires a numeric value`);
    }
    return { number };
  }
  return { text: String(rawValue) };
}

function redactProjectError(value: string): string {
  return redactSecrets(value).replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]+\b/g, "[REDACTED]");
}
