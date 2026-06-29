"use client";

export function StructuredJsonEditor({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  let parsed: unknown = null;
  let error: string | null = null;

  try {
    parsed = JSON.parse(value) as unknown;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (readOnly && parsed !== null) {
    return (
      <pre
        data-testid="json-readonly-pre"
        style={{
          height: "100%",
          minHeight: 0,
          overflow: "auto",
          margin: 0,
          padding: 14,
          background: "var(--bg)",
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  }

  const parsedObject = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto auto 1fr", height: "100%", minHeight: 0 }}>
      {parsedObject && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, padding: 10, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          {["id", "name", "provider", "model", "harnessRef"].map((field) => (
            <label key={field} style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--text-muted)" }}>
              {field}
              <input
                value={typeof parsedObject[field] === "string" ? parsedObject[field] as string : ""}
                readOnly={readOnly}
                onChange={(event) => {
                  const next = { ...parsedObject, [field]: event.target.value };
                  onChange(JSON.stringify(next, null, 2));
                }}
                style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", padding: "5px 7px", fontSize: 12 }}
              />
            </label>
          ))}
        </div>
      )}
      {error && (
        <div data-testid="json-validation-error" style={{ padding: "6px 10px", color: "#f87171", fontSize: 12, borderBottom: "1px solid var(--border)" }}>
          {error}
        </div>
      )}
      <textarea
        data-testid="json-raw-editor"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        readOnly={readOnly}
        style={{
          minHeight: 0,
          resize: "none",
          border: "none",
          outline: "none",
          padding: 14,
          background: "var(--bg)",
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      />
    </div>
  );
}
