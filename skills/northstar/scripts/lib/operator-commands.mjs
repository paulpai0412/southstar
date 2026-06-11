export const ISSUE_REQUIRED_ERROR = "NORTHSTAR_SKILL_ISSUE_REQUIRED";
export const CONFIG_REQUIRED_ERROR = "NORTHSTAR_SKILL_CONFIG_REQUIRED";
export const INVALID_WATCH_OPTION_ERROR = "NORTHSTAR_SKILL_INVALID_WATCH_OPTION";
export const UNKNOWN_INTENT_ERROR = "NORTHSTAR_SKILL_UNKNOWN_INTENT";
export const PLAN_SOURCE_REQUIRED_ERROR = "NORTHSTAR_SKILL_PLAN_SOURCE_REQUIRED";

const issueIntents = Object.freeze(["intake", "start", "reconcile", "release", "inspect"]);
const skillIntents = Object.freeze(["setup", "plan issues", "run", "status", "recover"]);
const phaseIntents = Object.freeze([
  "/northstar-setup",
  "/northstar-init",
  "/northstar-execute",
  "/northstar-watch",
  "/northstar-observe",
  "/northstar-status",
  "/northstar-recover",
  "/northstar-recovery",
  "/northstar-report",
]);
const planningIntents = Object.freeze([
  "/northstar-plan",
  "/northstar-grill",
  "/northstar-to-spec",
  "/northstar-to-plan",
  "/northstar-to-issues",
]);

export const supportedOperatorIntents = Object.freeze([...skillIntents, ...issueIntents, "watch", ...phaseIntents, ...planningIntents]);

const supportedOperatorIntentSet = new Set(supportedOperatorIntents);
const issueIntentSet = new Set(issueIntents);
const operatorCommandMetadata = { skill_operator_issue_commands_mapped: supportedOperatorIntents.length };
const phaseIntentMap = Object.freeze({
  "/northstar-setup": { legacyIntent: "setup", phase: "setup", canonical: "/northstar-setup" },
  "/northstar-init": { legacyIntent: "setup", phase: "setup", canonical: "/northstar-setup" },
  "/northstar-execute": { legacyIntent: "run", phase: "execute", canonical: "/northstar-execute" },
  "/northstar-watch": { legacyIntent: "watch", phase: "execute", canonical: "/northstar-execute" },
  "/northstar-observe": { legacyIntent: "status", phase: "observe", canonical: "/northstar-observe" },
  "/northstar-status": { legacyIntent: "status", phase: "observe", canonical: "/northstar-observe" },
  "/northstar-recover": { legacyIntent: "recover", phase: "recover", canonical: "/northstar-recover" },
  "/northstar-recovery": { legacyIntent: "recover", phase: "recover", canonical: "/northstar-recover" },
  "/northstar-report": { legacyIntent: "status", phase: "report", canonical: "/northstar-report" },
});
const planningIntentMap = Object.freeze({
  "/northstar-plan": "interactive",
  "/northstar-grill": "grill",
  "/northstar-to-spec": "spec",
  "/northstar-to-plan": "implementation-plan",
  "/northstar-to-issues": "issue-table",
});
const planningSkillLineageByIntent = Object.freeze({
  "/northstar-plan": ["northstar:planning-grill"],
  "/northstar-grill": ["northstar:planning-grill"],
  "/northstar-to-spec": ["northstar:planning-spec"],
  "/northstar-to-plan": ["northstar:implementation-planning"],
  "/northstar-to-issues": ["northstar:issue-slicing"],
});

export function commandPlanForIntent(input = {}) {
  const intent = input.intent;
  if (typeof intent !== "string" || !supportedOperatorIntentSet.has(intent)) {
    throw newOperatorCommandError(UNKNOWN_INTENT_ERROR);
  }

  const configPath = normalizeConfigPath(input.configPath);
  if (Object.hasOwn(planningIntentMap, intent)) {
    return commandPlanForPlanningIntent(intent, configPath, input);
  }

  if (Object.hasOwn(phaseIntentMap, intent)) {
    return commandPlanForPhaseIntent(intent, configPath, input);
  }

  if (intent === "plan issues") {
    return {
      argv: [
        "node", "--run", "northstar", "--", "plan-issues",
        "--config", configPath,
        "--spec", normalizeRequiredPath(input.specPath),
        "--plan", normalizeRequiredPath(input.planPath),
        "--dry-run",
      ],
      metadata: { ...operatorCommandMetadata },
    };
  }

  const argv = argvForIntent(intent, configPath);

  if (issueIntentSet.has(intent)) {
    argv.push("--issue", normalizeIssue(input.issue));
  }

  if (intent === "watch") {
    if (input.maxCycles !== undefined) {
      argv.push("--max-cycles", normalizePositiveInteger(input.maxCycles, INVALID_WATCH_OPTION_ERROR));
    }

    if (input.logJson === true) {
      argv.push("--log-json");
    } else if (input.logJson !== undefined && input.logJson !== false) {
      throw newOperatorCommandError(INVALID_WATCH_OPTION_ERROR);
    }
  }

  return { argv, metadata: { ...operatorCommandMetadata } };
}

function commandPlanForPlanningIntent(intent, configPath, input) {
  const planningMode = planningIntentMap[intent];
  const metadata = {
    phase_command_mapped: 1,
    phase: "plan",
    planning_mode: planningMode,
    skill_lineage: [...planningSkillLineageByIntent[intent]],
  };
  if (intent === "/northstar-plan" || intent === "/northstar-grill") {
    return {
      argv: [
        "node", "--run", "northstar", "--", "plan-grill",
        "--config", configPath,
        "--brief", normalizeRequiredPath(input.briefPath),
        "--dry-run",
      ],
      metadata,
    };
  }

  if (intent === "/northstar-to-spec") {
    return {
      argv: [
        "node", "--run", "northstar", "--", "plan-spec",
        "--config", configPath,
        "--brief", normalizeRequiredPath(input.briefPath),
        "--answers", normalizeRequiredPath(input.answersPath),
        "--out", normalizeRequiredPath(input.specPath),
      ],
      metadata,
    };
  }

  if (intent === "/northstar-to-plan") {
    return {
      argv: [
        "node", "--run", "northstar", "--", "plan-implementation",
        "--config", configPath,
        "--spec", normalizeRequiredPath(input.specPath),
        "--out", normalizeRequiredPath(input.planPath),
      ],
      metadata,
    };
  }

  if (intent === "/northstar-to-issues") {
    return {
      argv: [
        "node", "--run", "northstar", "--", "plan-issues",
        "--config", configPath,
        "--spec", normalizeRequiredPath(input.specPath),
        "--plan", normalizeRequiredPath(input.planPath),
        "--dry-run",
      ],
      metadata,
    };
  }

  throw newOperatorCommandError(UNKNOWN_INTENT_ERROR);
}

function commandPlanForPhaseIntent(intent, configPath, input) {
  const mapping = phaseIntentMap[intent];
  const argv = argvForIntent(mapping.legacyIntent, configPath);
  if (mapping.legacyIntent === "watch") {
    appendWatchOptions(argv, input);
  }

  return {
    argv,
    metadata: {
      phase_command_mapped: 1,
      phase: mapping.phase,
      canonical_intent: mapping.canonical,
    },
  };
}

function argvForIntent(intent, configPath) {
  if (intent === "setup") {
    return ["node", "--run", "northstar", "--", "doctor", "--config", configPath];
  }

  if (intent === "run") {
    return ["node", "--run", "northstar", "--", "watch", "--config", configPath];
  }

  if (intent === "status") {
    return ["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"];
  }

  if (intent === "recover") {
    return ["node", "--run", "northstar", "--", "repair-runtime", "--config", configPath];
  }

  return ["node", "--run", "northstar", "--", intent, "--config", configPath];
}

function appendWatchOptions(argv, input) {
  if (input.maxCycles !== undefined) {
    argv.push("--max-cycles", normalizePositiveInteger(input.maxCycles, INVALID_WATCH_OPTION_ERROR));
  }

  if (input.logJson === true) {
    argv.push("--log-json");
  } else if (input.logJson !== undefined && input.logJson !== false) {
    throw newOperatorCommandError(INVALID_WATCH_OPTION_ERROR);
  }
}

function normalizeConfigPath(configPath) {
  if (typeof configPath === "string" && configPath.trim() !== "") {
    return configPath;
  }

  throw newOperatorCommandError(CONFIG_REQUIRED_ERROR);
}

function normalizeIssue(issue) {
  return normalizePositiveInteger(issue, ISSUE_REQUIRED_ERROR);
}

function normalizeRequiredPath(value) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  throw newOperatorCommandError(PLAN_SOURCE_REQUIRED_ERROR);
}

function normalizePositiveInteger(value, errorCode) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }

  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return value;
  }

  throw newOperatorCommandError(errorCode);
}

function newOperatorCommandError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
