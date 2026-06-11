#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { redactSecrets, runDoctor } from "./lib/doctor.mjs";

export function parseDoctorArgs(args) {
  const parsed = {
    requireReady: false,
    configPath: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      continue;
    }
    if (arg === "--require-ready") {
      parsed.requireReady = true;
      continue;
    }
    if (arg === "--config") {
      const configPath = args[index + 1];
      if (typeof configPath !== "string" || configPath.trim() === "") {
        throw new Error("--config requires a path");
      }
      parsed.configPath = configPath;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseDoctorArgs(process.argv.slice(2));
    const result = await runDoctor({ configPath: options.configPath });
    console.log(JSON.stringify(result, null, 2));
    if (options.requireReady && !result.ready) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
