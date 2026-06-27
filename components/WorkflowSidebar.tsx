"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkflowAgentSummary, WorkflowLibrary, WorkflowTemplateSummary } from "@/lib/workflow/types";
import { getFileIcon, FolderIcon } from "./FileIcons";

interface Props {
  cwd: string | null;
  selectedTemplateId: string | null;
  onTemplateSelect: (template: WorkflowTemplateSummary) => void;
  onOpenResource: (resourcePath: string, label: string) => void;
}

export function WorkflowSidebar({ cwd, selectedTemplateId, onTemplateSelect, onOpenResource }: Props) {
  const [library, setLibrary] = useState<WorkflowLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const url = cwd ? `/api/workflow/library?cwd=${encodeURIComponent(cwd)}` : "/api/workflow/library";
    fetch(url)
      .then((res) => res.json())
      .then((data: { library?: WorkflowLibrary; error?: string }) => {
        if (data.error) throw new Error(data.error);
        setLibrary(data.library ?? { domains: [] });
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [cwd]);

  const templates = useMemo(
    () => library?.domains.flatMap((domain) => domain.workflowTemplates) ?? [],
    [library]
  );
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0] ?? null;
  const selectedAgentRefs = new Set(selectedTemplate?.agentRefs ?? []);
  const domains = library?.domains ?? [];

  useEffect(() => {
    if (!selectedTemplateId && selectedTemplate) onTemplateSelect(selectedTemplate);
  }, [selectedTemplateId, selectedTemplate, onTemplateSelect]);

  const toggle = useCallback((key: string) => {
    setOpenMap((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  }, []);

  const isOpen = useCallback((key: string) => openMap[key] ?? true, [openMap]);

  return (
    <div data-testid="workflow-sidebar" style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      {error && <div style={{ padding: 10, color: "#f87171", fontSize: 12 }}>{error}</div>}

      <section style={{ flex: "0 0 38%", minHeight: 120, overflow: "auto", borderBottom: "1px solid var(--border)" }}>
        <SectionHeader
          title="Workflow Templates"
          open={templatesOpen}
          onToggle={() => setTemplatesOpen((value) => !value)}
          testId="workflow-template-section-toggle"
        />
        {templatesOpen && (
          <div data-testid="workflow-template-tree" style={{ padding: "0 6px 8px" }}>
            {domains.map((domain) => {
              const domainKey = `templates:${domain.id}`;
              const workflowsKey = `templates:${domain.id}:workflows`;
              return (
                <div key={domain.id}>
                  <TreeFolderRow label={domain.id} depth={0} open={isOpen(domainKey)} onToggle={() => toggle(domainKey)} />
                  {isOpen(domainKey) && (
                    <>
                      <TreeFolderRow label="workflows" depth={1} open={isOpen(workflowsKey)} onToggle={() => toggle(workflowsKey)} />
                      {isOpen(workflowsKey) && domain.workflowTemplates.map((template) => (
                        <button
                          key={template.id}
                          onClick={() => onTemplateSelect(template)}
                          style={{
                            width: "100%",
                            minHeight: 38,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "6px 7px 6px 36px",
                            border: "none",
                            borderRadius: 6,
                            background: selectedTemplate?.id === template.id ? "var(--bg-selected)" : "transparent",
                            color: "var(--text)",
                            textAlign: "left",
                            cursor: "pointer",
                            fontSize: 12,
                          }}
                        >
                          <span style={{ width: 14, display: "flex", alignItems: "center", flexShrink: 0 }}>{getFileIcon("workflow.json", 14)}</span>
                          <span style={{ minWidth: 0, flex: 1 }}>
                            <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{template.title}</span>
                            <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{template.agentRefs.length} agents</span>
                          </span>
                          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 11 }}>{template.status}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
        <SectionHeader
          title="Agent Profiles"
          open={agentsOpen}
          onToggle={() => setAgentsOpen((value) => !value)}
          testId="workflow-agent-section-toggle"
        />
        {agentsOpen && (
          <div data-testid="workflow-agent-tree" style={{ padding: "2px 4px 8px" }}>
            {domains.map((domain) => {
              const domainKey = `agents:${domain.id}`;
              const agentsKey = `agents:${domain.id}:agents`;
              return (
                <div key={domain.id}>
                  <TreeFolderRow label={domain.id} depth={0} open={isOpen(domainKey)} onToggle={() => toggle(domainKey)} />
                  {isOpen(domainKey) && (
                    <>
                      <TreeFolderRow label="agents" depth={1} open={isOpen(agentsKey)} onToggle={() => toggle(agentsKey)} />
                      {isOpen(agentsKey) && domain.agents
                        .filter((agent) => !selectedTemplate || selectedAgentRefs.has(agent.id))
                        .map((agent) => (
                          <AgentTree
                            key={agent.id}
                            agent={agent}
                            isOpen={isOpen}
                            onToggle={toggle}
                            onOpenResource={onOpenResource}
                          />
                        ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function SectionHeader({
  title,
  open,
  onToggle,
  testId,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onToggle}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 10px",
        border: "none",
        background: "transparent",
        color: "var(--text-muted)",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 650,
        textTransform: "uppercase",
      }}
    >
      <Chevron open={open} />
      {title}
    </button>
  );
}

function TreeFolderRow({
  label,
  depth,
  open,
  onToggle,
}: {
  label: string;
  depth: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: "100%",
        height: 24,
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 8 + depth * 14,
        border: "none",
        background: "transparent",
        color: "var(--text)",
        cursor: "pointer",
        fontSize: 12,
        textAlign: "left",
      }}
    >
      <Chevron open={open} />
      <FolderIcon size={14} open={open} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}

function FileRow({
  resourcePath,
  label,
  depth,
  onOpenResource,
}: {
  resourcePath: string;
  label: string;
  depth: number;
  onOpenResource: (resourcePath: string, label: string) => void;
}) {
  return (
    <button
      onClick={() => onOpenResource(resourcePath, label)}
      style={{
        width: "100%",
        height: 24,
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 8 + depth * 14,
        paddingRight: 8,
        border: "none",
        borderRadius: 4,
        background: "transparent",
        color: "var(--text)",
        cursor: "pointer",
        fontSize: 12,
        textAlign: "left",
      }}
    >
      <span style={{ width: 14, display: "flex", alignItems: "center" }}>{getFileIcon(label, 14)}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}

function AgentTree({
  agent,
  isOpen,
  onToggle,
  onOpenResource,
}: {
  agent: WorkflowAgentSummary;
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
  onOpenResource: (resourcePath: string, label: string) => void;
}) {
  const baseKey = `agent:${agent.id}`;
  const skillsKey = `${baseKey}:skills`;
  const mcpKey = `${baseKey}:mcp`;
  const policiesKey = `${baseKey}:policies`;

  return (
    <div>
      <TreeFolderRow label={agent.label} depth={2} open={isOpen(baseKey)} onToggle={() => onToggle(baseKey)} />
      {isOpen(baseKey) && (
        <>
          <FileRow resourcePath={agent.profileResourcePath} label="profile.json" depth={3} onOpenResource={onOpenResource} />
          <FileRow resourcePath={agent.instructionResourcePath} label="instruction.md" depth={3} onOpenResource={onOpenResource} />

          <TreeFolderRow label="skills" depth={3} open={isOpen(skillsKey)} onToggle={() => onToggle(skillsKey)} />
          {isOpen(skillsKey) && agent.skillResourcePaths.map((resourcePath) => {
            const parts = resourcePath.split("/");
            const skillName = parts.at(-2) ?? "skill";
            const label = parts.at(-1) ?? resourcePath;
            const skillKey = `${skillsKey}:${skillName}`;
            return (
              <div key={resourcePath}>
                <TreeFolderRow label={skillName} depth={4} open={isOpen(skillKey)} onToggle={() => onToggle(skillKey)} />
                {isOpen(skillKey) && <FileRow resourcePath={resourcePath} label={label} depth={5} onOpenResource={onOpenResource} />}
              </div>
            );
          })}

          <TreeFolderRow label="mcp" depth={3} open={isOpen(mcpKey)} onToggle={() => onToggle(mcpKey)} />
          {isOpen(mcpKey) && agent.mcpResourcePaths.map((resourcePath) => (
            <FileRow key={resourcePath} resourcePath={resourcePath} label={resourcePath.split("/").at(-1) ?? resourcePath} depth={4} onOpenResource={onOpenResource} />
          ))}

          <TreeFolderRow label="policies" depth={3} open={isOpen(policiesKey)} onToggle={() => onToggle(policiesKey)} />
          {isOpen(policiesKey) && agent.policyResourcePaths.map((resourcePath) => (
            <FileRow key={resourcePath} resourcePath={resourcePath} label={resourcePath.split("/").at(-1) ?? resourcePath} depth={4} onOpenResource={onOpenResource} />
          ))}
        </>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        color: "var(--text-dim)",
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 0.12s",
      }}
    >
      <polyline points="3 2 7 5 3 8" />
    </svg>
  );
}
