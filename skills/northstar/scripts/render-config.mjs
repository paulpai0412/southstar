#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { maybeWriteConfig, renderConfigFromCwd } from "./lib/config-renderer.mjs";

export function parseRenderConfigArgs(args) {
  const parsed = {
    write: false,
    confirmed: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--write") {
      parsed.write = true;
      continue;
    }
    if (arg === "--confirmed") {
      parsed.confirmed = true;
      continue;
    }
    if (arg === "--overwrite-existing") {
      parsed.allowOverwrite = true;
      continue;
    }
    if (arg === "--json") {
      continue;
    }

    if (!["--cwd", "--github-repo", "--base-branch"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === "--cwd") {
      parsed.cwd = value;
    } else if (arg === "--github-repo") {
      parsed.githubRepo = value;
    } else if (arg === "--base-branch") {
      parsed.baseBranch = value;
    }
    index += 1;
  }

  return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseRenderConfigArgs(process.argv.slice(2));
    const draft = await renderConfigFromCwd(options);
    const writeResult = options.write
      ? await maybeWriteConfig({
        path: draft.path,
        content: draft.content,
        workflowPath: draft.workflowPath,
        workflowContent: draft.workflowContent,
        confirmed: options.confirmed,
        allowOverwrite: options.allowOverwrite,
      })
      : { path: draft.path, wrote: false, workflowPath: draft.workflowPath, workflowWrote: false };
    console.log(JSON.stringify({ ...draft, ...writeResult }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
