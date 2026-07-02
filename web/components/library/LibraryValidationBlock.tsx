"use client";

export function LibraryValidationBlock({ data }: { data: Record<string, unknown> }) {
  const issues = Array.isArray(data.issues) ? data.issues : [];
  return (
    <div data-testid="library-validation-block">
      <div style={{ fontWeight: 700, color: data.ok === false ? "var(--danger, #dc2626)" : "var(--accent)" }}>
        {data.ok === false ? "Validation failed" : "Validation passed"}
      </div>
      {issues.map((issue, index) => (
        <div key={index} style={{ fontSize: 12 }}>
          {formatIssue(issue)}
        </div>
      ))}
    </div>
  );
}

function formatIssue(issue: unknown): string {
  if (!issue || typeof issue !== "object") return String(issue);
  const record = issue as { path?: unknown; message?: unknown };
  const path = typeof record.path === "string" ? record.path : "issue";
  const message = typeof record.message === "string" ? record.message : JSON.stringify(issue);
  return `${path}: ${message}`;
}
