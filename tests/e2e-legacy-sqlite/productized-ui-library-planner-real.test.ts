import test from "node:test";
import { loadRealE2EEnv } from "./env.ts";
import { runProductizedUiLibraryPlannerRealScenario } from "./scenarios/productized-ui-library-planner-real.ts";

test("Productized UI library-aware planner real E2E", async () => {
  const env = await loadRealE2EEnv();
  await runProductizedUiLibraryPlannerRealScenario(env);
});
