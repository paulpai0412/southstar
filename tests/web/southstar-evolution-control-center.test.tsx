import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
function source(path: string): string { return readFileSync(join(root, path), "utf8"); }

test("Evolution Control Center is a top-level Southstar page and app-shell tab", () => {
  assert.match(source("app/evolution/page.tsx"), /EvolutionControlCenterPage/);
  const rail = source("components/southstar/app-shell/SouthstarTabRail.tsx");
  assert.match(rail, /evolution/);
  assert.match(rail, /Evolution/);
  assert.match(rail, /Learning graph/);
});

test("Evolution Control Center renders all required sections including wiki backlinks", () => {
  const page = source("components/southstar/pages/EvolutionControlCenterPage.tsx");
  for (const text of [
    "Evolution Health Overview",
    "Learning Signal Feed",
    "Knowledge Card Library",
    "Delta Proposal Queue",
    "Sandbox Experiments",
    "Asset Version Registry",
    "Canary / Regression Monitor",
    "Graph Viewer",
    "Knowledge Wiki",
  ]) {
    assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(page, /\/api\/v2\/read-models\/evolution-control-center\/_global/);
  assert.match(page, /KnowledgeWikiPanel/);
  assert.match(page, /EvolutionGraphViewer/);
});

test("Evolution Control Center exposes command buttons for card, delta, sandbox, asset, and alert operations", () => {
  const page = source("components/southstar/pages/EvolutionControlCenterPage.tsx");
  for (const text of [
    "Approve card",
    "Reject card",
    "Approve delta",
    "Reject delta",
    "Run sandbox",
    "Rollback asset",
    "Acknowledge alert",
    "Dismiss alert",
  ]) {
    assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const endpoint of [
    "/api/v2/evolution/cards/",
    "/api/v2/evolution/deltas/",
    "/api/v2/evolution/experiments/",
    "/api/v2/evolution/assets/",
    "/api/v2/evolution/regression-alerts/",
  ]) {
    assert.match(page, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Graph viewer supports node selection and wiki link moderation actions", () => {
  const graph = source("components/southstar/evolution/EvolutionGraphViewer.tsx");
  assert.match(graph, /onSelectNode/);
  assert.match(graph, /button/);
  assert.match(graph, /aria-label=\{`Select graph node/);

  const panel = source("components/southstar/evolution/KnowledgeWikiPanel.tsx");
  for (const text of ["Approve link", "Reject link", "Normalize aliases", "Rewire stale backlinks", "Open conflict", "Resolve conflict"]) {
    assert.match(panel, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(panel, /\/api\/v2\/evolution\/wiki\/links\//);
  assert.match(panel, /\/api\/v2\/evolution\/wiki\/maintenance\/rewire-stale/);
});

test("Knowledge Wiki panel exposes backlinks, evidence, runtime usage, downstream impact, and conflicts", () => {
  const panel = source("components/southstar/evolution/KnowledgeWikiPanel.tsx");
  for (const text of ["Forward links", "Backlinks", "Evidence", "Runtime usage", "Downstream impact", "Conflicts", "Supersession"]) {
    assert.match(panel, new RegExp(text));
  }
  assert.match(panel, /\/api\/v2\/evolution\/wiki\//);
  assert.doesNotMatch(panel, /knowledge_wiki_pages|knowledge_wiki_links/);
});
