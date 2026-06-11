const NORTHSTAR_ROOT = "__NORTHSTAR_ROOT__";
const PLAYBOOK_PATH = `${NORTHSTAR_ROOT}/docs/agent-playbooks/northstar-operator.md`;

const commands = [
  ["northstar-plan", "Northstar planning entrypoint"],
  ["northstar-grill", "Northstar planning grill"],
  ["northstar-to-spec", "Northstar PRD/spec generation"],
  ["northstar-to-plan", "Northstar implementation plan generation"],
  ["northstar-to-issues", "Northstar issue draft or creation flow"],
  ["northstar-setup", "Northstar setup and doctor checks"],
  ["northstar-init", "Alias for Northstar setup"],
  ["northstar-execute", "Northstar guided execution"],
  ["northstar-watch", "Alias for Northstar execution watch"],
  ["northstar-observe", "Northstar status and evidence observation"],
  ["northstar-status", "Alias for Northstar observe"],
  ["northstar-recover", "Northstar recovery"],
  ["northstar-recovery", "Alias for Northstar recovery"],
  ["northstar-report", "Northstar audit report"],
];

export default function northstarPiExtension(pi) {
  for (const [name, description] of commands) {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        const request = [
          `Use ${PLAYBOOK_PATH} as the source of truth.`,
          `Handle /${name}${args ? ` ${args}` : ""}.`,
          "Treat the current working directory as the consumer repository unless another path is supplied.",
          `Use ${NORTHSTAR_ROOT} as the Northstar runtime root.`,
          "Call Northstar through explicit CLI argv such as `node --run northstar -- inspect --config <config> --summary`.",
          "Show exact argv before mutation and follow the playbook gates for config, GitHub, Project, runtime, branch, PR, and release mutations.",
        ].join("\n");

        if (typeof pi.sendUserMessage === "function") {
          pi.sendUserMessage(request);
          return;
        }

        ctx.ui.setEditorText(request);
        ctx.ui.notify(`Prepared /${name} request in the editor.`, "info");
      },
    });
  }
}

