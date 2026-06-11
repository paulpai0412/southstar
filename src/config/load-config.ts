import { readFileSync } from "node:fs";
import { ALLOWED_BOOTSTRAP_ENV, validateRuntimeConfig } from "./schema.ts";
import type { RuntimeConfig } from "./schema.ts";

export function loadConfig(path: string, projectRootOverride?: string): RuntimeConfig {
  const rawConfig = parseYamlSubset(readFileSync(path, "utf8"));
  const config = validateRuntimeConfig(rawConfig);
  return projectRootOverride
    ? { ...config, project: { ...config.project, root: projectRootOverride } }
    : config;
}

export function readBootstrapEnv(env: Record<string, string | undefined> = process.env) {
  const result: Record<string, string | undefined> = {};

  for (const key of ALLOWED_BOOTSTRAP_ENV) {
    if (env[key] !== undefined) {
      result[key] = env[key];
    }
  }

  return result;
}

export function parseYamlSubset(content: string): unknown {
  const lines = content
    .split(/\r?\n/)
    .map((raw) => {
      const indent = raw.match(/^ */)?.[0].length ?? 0;
      return { indent, text: raw.trim() };
    })
    .filter((line) => line.text.length > 0 && !line.text.startsWith("#"));

  if (lines.length === 0) {
    return {};
  }

  return parseBlock(lines, 0, lines[0].indent).value;
}

interface ParsedLine {
  indent: number;
  text: string;
}

function parseBlock(lines: ParsedLine[], start: number, indent: number): { value: unknown; next: number } {
  if (lines[start]?.text.startsWith("- ")) {
    return parseArray(lines, start, indent);
  }
  return parseObject(lines, start, indent);
}

function parseObject(lines: ParsedLine[], start: number, indent: number): { value: Record<string, unknown>; next: number } {
  const value: Record<string, unknown> = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new Error(`Unexpected indentation near "${line.text}"`);
    }
    if (line.text.startsWith("- ")) {
      break;
    }

    const separator = line.text.indexOf(":");
    if (separator === -1) {
      throw new Error(`Invalid YAML mapping line "${line.text}"`);
    }

    const key = line.text.slice(0, separator).trim();
    const rest = line.text.slice(separator + 1).trim();
    if (rest.length > 0) {
      value[key] = parseScalar(rest);
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1];
    if (!nextLine || nextLine.indent <= indent) {
      value[key] = {};
      index += 1;
      continue;
    }

    const parsed = parseBlock(lines, index + 1, nextLine.indent);
    value[key] = parsed.value;
    index = parsed.next;
  }

  return { value, next: index };
}

function parseArray(lines: ParsedLine[], start: number, indent: number): { value: unknown[]; next: number } {
  const value: unknown[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new Error(`Unexpected array indentation near "${line.text}"`);
    }
    if (!line.text.startsWith("- ")) {
      break;
    }

    const rest = line.text.slice(2).trim();
    if (rest.length > 0) {
      const inlineSeparator = rest.indexOf(":");
      if (inlineSeparator !== -1) {
        const key = rest.slice(0, inlineSeparator).trim();
        const scalarText = rest.slice(inlineSeparator + 1).trim();
        const item: Record<string, unknown> = {
          [key]: scalarText.length > 0 ? parseScalar(scalarText) : {},
        };
        const nextLine = lines[index + 1];
        if (nextLine && nextLine.indent > line.indent) {
          const parsed = parseObject(lines, index + 1, nextLine.indent);
          Object.assign(item, parsed.value);
          value.push(item);
          index = parsed.next;
          continue;
        }
        value.push(item);
        index += 1;
        continue;
      }

      value.push(parseScalar(rest));
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1];
    if (!nextLine || nextLine.indent <= indent) {
      value.push(null);
      index += 1;
      continue;
    }

    const parsed = parseBlock(lines, index + 1, nextLine.indent);
    value.push(parsed.value);
    index = parsed.next;
  }

  return { value, next: index };
}

function parseScalar(value: string): string | number | boolean | unknown[] {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "[]") {
    return [];
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}
