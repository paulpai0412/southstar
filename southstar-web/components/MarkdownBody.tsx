"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import remarkGfm from "remark-gfm";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

type MarkdownBodyProps = {
  children: ReactNode;
  className?: string;
  isStreaming?: boolean;
};

function markdownText(children: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(markdownText).join("");
  return String(children);
}

function languageFromClassName(className?: string): string {
  const match = /language-([a-z0-9_-]+)/i.exec(className ?? "");
  return match?.[1] ?? "text";
}

type CodeProps = ComponentPropsWithoutRef<"code"> & {
  inline?: boolean;
};

const markdownComponents: Components = {
  a: (props: ComponentPropsWithoutRef<"a">) => (
    <a
      {...props}
      target="_blank"
      rel="noreferrer"
      style={{ color: "var(--accent)", textDecoration: "none" }}
    />
  ),
  p: (props: ComponentPropsWithoutRef<"p">) => (
    <p {...props} style={{ margin: "0 0 0.75em", lineHeight: 1.65 }} />
  ),
  ul: (props: ComponentPropsWithoutRef<"ul">) => (
    <ul {...props} style={{ margin: "0.25em 0 0.85em", paddingLeft: "1.35em" }} />
  ),
  ol: (props: ComponentPropsWithoutRef<"ol">) => (
    <ol {...props} style={{ margin: "0.25em 0 0.85em", paddingLeft: "1.45em" }} />
  ),
  li: (props: ComponentPropsWithoutRef<"li">) => (
    <li {...props} style={{ margin: "0.18em 0", lineHeight: 1.6 }} />
  ),
  blockquote: (props: ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      {...props}
      style={{
        margin: "0.75em 0",
        padding: "0.15em 0 0.15em 0.85em",
        borderLeft: "3px solid var(--border)",
        color: "var(--text-muted)",
      }}
    />
  ),
  table: (props: ComponentPropsWithoutRef<"table">) => (
    <div style={{ overflowX: "auto", margin: "0.75em 0" }}>
      <table
        {...props}
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      />
    </div>
  ),
  th: (props: ComponentPropsWithoutRef<"th">) => (
    <th
      {...props}
      style={{
        padding: "6px 8px",
        border: "1px solid var(--border)",
        background: "var(--bg-panel)",
        textAlign: "left",
      }}
    />
  ),
  td: (props: ComponentPropsWithoutRef<"td">) => (
    <td
      {...props}
      style={{
        padding: "6px 8px",
        border: "1px solid var(--border)",
        verticalAlign: "top",
      }}
    />
  ),
  h1: (props: ComponentPropsWithoutRef<"h1">) => <h1 {...props} style={{ fontSize: 22, margin: "0.2em 0 0.55em" }} />,
  h2: (props: ComponentPropsWithoutRef<"h2">) => <h2 {...props} style={{ fontSize: 18, margin: "0.35em 0 0.55em" }} />,
  h3: (props: ComponentPropsWithoutRef<"h3">) => <h3 {...props} style={{ fontSize: 15, margin: "0.45em 0 0.45em" }} />,
  hr: (props: ComponentPropsWithoutRef<"hr">) => <hr {...props} style={{ border: "none", borderTop: "1px solid var(--border)", margin: "1em 0" }} />,
  code: ({ inline, className: codeClassName, children: codeChildren, ...props }: CodeProps) => {
    const code = String(codeChildren ?? "").replace(/\n$/, "");
    if (inline) {
      return (
        <code
          {...props}
          style={{
            padding: "1px 4px",
            borderRadius: 4,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.92em",
          }}
        >
          {codeChildren}
        </code>
      );
    }

    return (
      <div className="markdown-code-block" style={{ margin: "0.75em 0", overflow: "hidden", borderRadius: 6, border: "1px solid var(--border)" }}>
        <SyntaxHighlighter
          language={languageFromClassName(codeClassName)}
          PreTag="div"
          style={vscDarkPlus}
          customStyle={{
            margin: 0,
            padding: "12px 14px",
            background: "var(--bg-panel)",
            fontSize: 12,
            lineHeight: 1.55,
            fontFamily: "var(--font-mono)",
          }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
          wrapLongLines
        >
          {code}
        </SyntaxHighlighter>
      </div>
    );
  },
};

export function MarkdownBody({ children, className, isStreaming }: MarkdownBodyProps) {
  const text = markdownText(children);

  return (
    <div
      className={className}
      data-streaming={isStreaming ? "true" : undefined}
      style={{
        color: "inherit",
        overflowWrap: "anywhere",
        wordBreak: "normal",
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
