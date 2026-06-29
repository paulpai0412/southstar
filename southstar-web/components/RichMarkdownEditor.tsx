"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bold,
  Code2,
  Heading2,
  Italic,
  Link,
  List,
  ListOrdered,
  PanelLeft,
  PanelRight,
  Pilcrow,
  Quote,
  SplitSquareHorizontal,
} from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";

type EditorMode = "edit" | "preview" | "split";

type RichMarkdownEditorProps = {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
};

type MarkdownCommand = {
  id: string;
  title: string;
  icon: typeof Bold;
  apply: (selection: string) => { next: string; cursorOffset: number; selectLength?: number };
};

const commands: MarkdownCommand[] = [
  {
    id: "bold",
    title: "Bold",
    icon: Bold,
    apply: (selection) => wrapSelection(selection, "**", "strong text"),
  },
  {
    id: "italic",
    title: "Italic",
    icon: Italic,
    apply: (selection) => wrapSelection(selection, "_", "emphasis"),
  },
  {
    id: "code",
    title: "Inline code",
    icon: Code2,
    apply: (selection) => wrapSelection(selection, "`", "code"),
  },
  {
    id: "heading",
    title: "Heading",
    icon: Heading2,
    apply: (selection) => prefixLines(selection, "## ", "Heading"),
  },
  {
    id: "list",
    title: "Bullet list",
    icon: List,
    apply: (selection) => prefixLines(selection, "- ", "List item"),
  },
  {
    id: "ordered-list",
    title: "Ordered list",
    icon: ListOrdered,
    apply: (selection) => {
      const text = selection || "List item";
      const lines = text.split("\n").map((line, index) => `${index + 1}. ${line || "List item"}`);
      return { next: lines.join("\n"), cursorOffset: 0, selectLength: lines.join("\n").length };
    },
  },
  {
    id: "quote",
    title: "Quote",
    icon: Quote,
    apply: (selection) => prefixLines(selection, "> ", "Quote"),
  },
  {
    id: "link",
    title: "Link",
    icon: Link,
    apply: (selection) => {
      const label = selection || "link text";
      return { next: `[${label}](https://example.com)`, cursorOffset: 1, selectLength: label.length };
    },
  },
];

function wrapSelection(selection: string, marker: string, fallback: string) {
  const text = selection || fallback;
  return {
    next: `${marker}${text}${marker}`,
    cursorOffset: marker.length,
    selectLength: text.length,
  };
}

function prefixLines(selection: string, prefix: string, fallback: string) {
  const text = selection || fallback;
  const next = text
    .split("\n")
    .map((line) => `${prefix}${line || fallback}`)
    .join("\n");
  return { next, cursorOffset: prefix.length, selectLength: next.length - prefix.length };
}

export function RichMarkdownEditor({ value, onChange, readOnly }: RichMarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mode, setMode] = useState<EditorMode>(readOnly ? "preview" : "split");

  useEffect(() => {
    if (readOnly) setMode("preview");
  }, [readOnly]);

  function insertMarkdown(command: MarkdownCommand) {
    if (readOnly) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selection = value.slice(start, end);
    const result = command.apply(selection);
    const next = `${value.slice(0, start)}${result.next}${value.slice(end)}`;
    onChange(next);

    requestAnimationFrame(() => {
      textarea.focus();
      const selectionStart = start + result.cursorOffset;
      const selectionEnd = result.selectLength ? selectionStart + result.selectLength : selectionStart;
      textarea.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  const showEditor = mode === "edit" || mode === "split";
  const showPreview = mode === "preview" || mode === "split";

  return (
    <div
      data-testid="rich-markdown-editor"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      <div
        data-testid="markdown-toolbar"
        className="toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          minHeight: 36,
          padding: "5px 8px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          {commands.map((command) => {
            const Icon = command.icon;
            return (
              <button
                key={command.id}
                type="button"
                title={command.title}
                disabled={readOnly}
                onClick={() => insertMarkdown(command)}
                style={{
                  width: 28,
                  height: 26,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid transparent",
                  borderRadius: 5,
                  background: "transparent",
                  color: readOnly ? "var(--text-dim)" : "var(--text-muted)",
                  cursor: readOnly ? "default" : "pointer",
                  opacity: readOnly ? 0.45 : 1,
                }}
                onMouseEnter={(event) => {
                  if (readOnly) return;
                  event.currentTarget.style.background = "var(--bg-hover)";
                  event.currentTarget.style.color = "var(--text)";
                  event.currentTarget.style.borderColor = "var(--border)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "transparent";
                  event.currentTarget.style.color = readOnly ? "var(--text-dim)" : "var(--text-muted)";
                  event.currentTarget.style.borderColor = "transparent";
                }}
              >
                <Icon size={15} strokeWidth={1.9} />
              </button>
            );
          })}
        </div>

        <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />

        <div
          style={{
            display: "flex",
            border: "1px solid var(--border)",
            borderRadius: 6,
            overflow: "hidden",
            marginLeft: "auto",
          }}
        >
          {[
            { id: "edit" as const, label: "Edit", icon: PanelLeft },
            { id: "split" as const, label: "Split", icon: SplitSquareHorizontal },
            { id: "preview" as const, label: "Preview", icon: PanelRight },
          ].map((item) => {
            const Icon = item.icon;
            const active = mode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                title={item.label}
                onClick={() => setMode(item.id)}
                style={{
                  minWidth: 36,
                  height: 26,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  border: "none",
                  borderLeft: item.id === "edit" ? "none" : "1px solid var(--border)",
                  background: active ? "var(--bg-selected)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  padding: "0 8px",
                  fontSize: 11,
                  fontWeight: active ? 650 : 500,
                }}
              >
                <Icon size={14} strokeWidth={1.9} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: mode === "split" ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)",
          overflow: "hidden",
        }}
      >
        {showEditor && (
          <div style={{ display: "flex", minHeight: 0, borderRight: mode === "split" ? "1px solid var(--border)" : "none" }}>
            <textarea
              ref={textareaRef}
              aria-label="Markdown editor"
              value={value}
              readOnly={readOnly}
              spellCheck={false}
              onChange={(event) => onChange(event.target.value)}
              style={{
                width: "100%",
                height: "100%",
                minHeight: 0,
                boxSizing: "border-box",
                border: "none",
                outline: "none",
                resize: "none",
                padding: 14,
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            />
          </div>
        )}

        {showPreview && (
          <div style={{ minHeight: 0, overflow: "auto", padding: "16px 18px", background: "var(--bg)" }}>
            {value.trim() ? (
              <MarkdownBody>{value}</MarkdownBody>
            ) : (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
                <Pilcrow size={18} strokeWidth={1.7} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
