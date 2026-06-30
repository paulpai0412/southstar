export type WorkflowStreamAppendMode = "line" | "message.delta";

export function appendWorkflowStreamText(
  current: string,
  text: string,
  mode: WorkflowStreamAppendMode = "line"
): string {
  if (!text) return current;
  if (mode === "message.delta") return `${current}${text}`;
  return current ? `${current}\n${text}` : text;
}

export function normalizeWorkflowStreamText(input: string): string {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  const parsed = parseJson(text);
  if (parsed.ok) {
    return fencedJson(JSON.stringify(parsed.value, null, 2));
  }

  return formatEmbeddedJsonBlocks(text)
    .replace(/(\[[^\]\n]+][^\n]*?)(?=[\u4e00-\u9fff])/g, "$1\n\n")
    .replace(/}\s*{/g, "}\n\n{")
    .replace(/]\s*\[/g, "]\n\n[")
    .replace(/([。！？!?])\s*(接著|然後|下一步|最後|同時|另外|此外)/g, "$1\n\n$2")
    .replace(/([。！？!?])\n(\[[^\]\n]+])/g, "$1\n\n$2")
    .replace(/([^\n])\s*(#{1,6}\s+)/g, "$1\n\n$2")
    .replace(/([^\n])\s*(-\s+)/g, "$1\n$2")
    .replace(/([^\n])\s*(\\d+\\.\\s+)/g, "$1\n$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!isJsonLike(trimmed)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function isJsonLike(text: string): boolean {
  return (text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"));
}

function fencedJson(json: string): string {
  return `\`\`\`json\n${json}\n\`\`\``;
}

function formatEmbeddedJsonBlocks(text: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < text.length) {
    const start = findNextJsonStart(text, cursor);
    if (start === -1) {
      output += text.slice(cursor);
      break;
    }

    const end = findJsonEnd(text, start);
    if (end === -1) {
      output += text.slice(cursor);
      break;
    }

    const candidate = text.slice(start, end + 1);
    const parsed = parseJson(candidate);
    if (!parsed.ok) {
      output += text.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }

    output += text.slice(cursor, start).replace(/[ \t]+$/, "");
    output = output.replace(/:$/, ":");
    output += `${output.endsWith("\n") || output.length === 0 ? "" : "\n\n"}${fencedJson(JSON.stringify(parsed.value, null, 2))}`;
    cursor = end + 1;
  }

  return output;
}

function findNextJsonStart(text: string, from: number): number {
  const objectStart = text.indexOf("{", from);
  const arrayStart = text.indexOf("[", from);
  if (objectStart === -1) return arrayStart;
  if (arrayStart === -1) return objectStart;
  return Math.min(objectStart, arrayStart);
}

function findJsonEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return i;
    }
  }

  return -1;
}
