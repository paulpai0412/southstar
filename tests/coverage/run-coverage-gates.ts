import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const npmCommand = platform() === "win32" ? "npm.cmd" : "npm";

for (const script of ["test:coverage:requirements", "test:coverage:code"]) {
  const result = spawnSync(npmCommand, ["run", script], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
