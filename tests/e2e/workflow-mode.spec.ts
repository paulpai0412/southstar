import { test, expect, type Page } from "@playwright/test";

async function ensureChatReady(page: Page) {
  await page.route("**/api/sessions*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: "e2e-seed-session",
            cwd: "/home/timmypai/apps/southstar/web",
            path: "/tmp/e2e-seed-session.jsonl",
            created: "2026-06-27T00:00:00.000Z",
            modified: "2026-06-27T00:00:01.000Z",
            messageCount: 1,
            firstMessage: "seed",
          },
        ],
      }),
    });
  });

  await page.goto("/");
  const chatInput = page.getByTestId("chat-input");
  await expect(chatInput).toBeVisible({ timeout: 20000 });
}

test("workflow mode top bar keeps tabs, icon-only export/branch, and no system top-bar control", async ({ page }) => {
  await ensureChatReady(page);
  await expect(page.getByTestId("app-mode-rail")).toBeVisible();

  const topBar = page.getByTestId("app-mode-rail").locator("xpath=ancestor::div[1]");
  await expect(page.getByTestId("mode-chat")).toBeVisible();
  await expect(page.getByTestId("mode-workflow")).toBeVisible();
  await expect(page.getByTestId("mode-operator")).toBeVisible();

  const exportButton = page.getByRole("button", { name: "Export HTML" });
  const branchButton = page.getByRole("button", { name: "Branches" });

  await expect(exportButton).toBeVisible();
  await expect(branchButton).toBeVisible();
  await expect(exportButton).toHaveText(/^\s*$/);
  await expect(branchButton).toHaveText(/^\s*$/);
  await expect(topBar.getByText(/^System$/)).toHaveCount(0);
});

test("workflow sidebar sections collapse and expand with testid toggles", async ({ page }) => {
  await ensureChatReady(page);

  await page.getByTestId("mode-workflow").click();

  await expect(page.getByTestId("workflow-sidebar")).toBeVisible();
  const templateTree = page.getByTestId("workflow-template-tree");
  const agentTree = page.getByTestId("workflow-agent-tree");
  const templateToggle = page.getByTestId("workflow-template-section-toggle");
  const agentToggle = page.getByTestId("workflow-agent-section-toggle");

  await expect(templateTree).toBeVisible();
  await expect(agentTree).toBeVisible();

  await templateToggle.click();
  await expect(templateTree).toHaveCount(0);
  await templateToggle.click();
  await expect(templateTree).toBeVisible();

  await agentToggle.click();
  await expect(agentTree).toHaveCount(0);
  await agentToggle.click();
  await expect(agentTree).toBeVisible();
});

test("workflow prompt renders DAG arrows and lifecycle action buttons", async ({ page }) => {
  await ensureChatReady(page);

  await page.getByTestId("mode-workflow").click();
  const composer = page.locator('[data-testid="chat-input"] textarea');
  await expect(composer).toBeVisible();
  await composer.fill("Build a settings page with validation");
  await composer.press("Enter");

  await expect(page.getByTestId("workflow-dag-block")).toBeVisible();
  await expect(page.getByTestId("workflow-draft-saved")).toBeVisible();
  await expect(page.getByTestId("workflow-action-validate")).toBeVisible();
  await expect(page.getByTestId("workflow-action-run")).toBeVisible();
  await expect(page.getByTestId("workflow-lifecycle-notice")).toBeVisible();
  const dagArrows = page.getByTestId("workflow-dag-arrow");
  expect(await dagArrows.count()).toBeGreaterThan(0);
});

test("workflow node/profile selection renders full readonly json in pre", async ({ page }) => {
  await ensureChatReady(page);

  await page.getByTestId("mode-workflow").click();
  const composer = page.locator('[data-testid="chat-input"] textarea');
  await expect(composer).toBeVisible();
  await composer.fill("Build a settings page with validation");
  await composer.press("Enter");

  const firstDagNode = page.locator('[data-testid^="workflow-dag-node-"]').first();
  await expect(firstDagNode).toBeVisible();
  await firstDagNode.click();
  await expect(page.getByTestId("workflow-resource-viewer")).toContainText("profile.json");
  const dagNodePre = page.getByTestId("json-readonly-pre");
  await expect(dagNodePre).toBeVisible();
  await expect(dagNodePre).toContainText('"toolPolicy"');
  await expect(dagNodePre).toContainText('"budgetPolicy"');
  await expect(dagNodePre).toContainText('"maxWallTimeSeconds"');

  await page.getByText("profile.json").first().click();
  const profilePre = page.getByTestId("json-readonly-pre");
  await expect(profilePre).toBeVisible();
  await expect(profilePre).toContainText('"provider"');
  await expect(profilePre).toContainText('"model"');

  const preMetrics = await profilePre.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: window.getComputedStyle(element).overflowY,
  }));
  expect(preMetrics.overflowY).toBe("auto");
  expect(preMetrics.scrollHeight).toBeGreaterThanOrEqual(preMetrics.clientHeight);
});
