import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const configRendererModule = "../../skills/northstar/scripts/lib/config-renderer.mjs";
const renderConfigModule = "../../skills/northstar/scripts/render-config.mjs";
const execFileAsync = promisify(execFile);

test("northstar config renderer creates draft content and does not write by default", async () => {
  const { renderNorthstarConfigDraft } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-"));
  const configPath = join(dir, "northstar.yaml");
  const workflowPath = join(dir, ".northstar", "workflows", "issue-to-pr-release.yaml");

  try {
    const draft = await renderNorthstarConfigDraft({
      projectName: "example",
      projectRoot: dir,
      githubRepo: "owner/repo",
      baseBranch: "trunk",
      path: configPath,
    });

    assert.equal(draft.path, configPath);
    assert.match(draft.content, /schema_version: "1\.1"/);
    assert.match(draft.content, /name: example/);
    assert.match(draft.content, new RegExp(`root: "${dir.replaceAll("\\", "\\\\")}"`));
    assert.match(draft.content, /repo: owner\/repo/);
    assert.match(draft.content, /base_branch: trunk/);
    assert.match(draft.content, /auto_release: true/);
    assert.match(draft.content, /watch_lock_stale_seconds: 120/);
    assert.match(draft.content, /max_recovery_attempts: 2/);
    assert.match(draft.content, /completed_worktrees: archive/);
    assert.match(draft.content, /keep_last: 5/);
    assert.match(draft.content, /failed_or_quarantined: keep/);
    assert.match(draft.content, /enabled: false/);
    assert.match(draft.content, /token_env: GITHUB_TOKEN/);
    assert.match(draft.content, /allow_gh_token_fallback: true/);
    assert.match(draft.content, /codex:\n      mode: sdk_default/);
    assert.match(draft.content, /opencode:\n      mode: sdk_default/);
    assert.match(draft.content, /pi:\n      mode: sdk_default/);
    assert.match(draft.content, /github_sync_blocks_lifecycle: false/);
    assert.match(draft.content, /quarantine_requires_operator: true/);
    assert.equal(draft.skill_bootstrap_config_draft_created, 1);
    assert.equal(draft.workflowPath, workflowPath);
    assert.match(draft.workflowContent, /id: issue_to_pr_release/);
    assert.match(draft.workflowContent, /version: "2\.0"/);
    assert.match(draft.workflowContent, /implementation_agent/);
    assert.equal(draft.skill_bootstrap_workflow_draft_created, 1);
    assert.equal(draft.skill_bootstrap_requires_confirmation, 1);
    await assert.rejects(() => access(configPath), { code: "ENOENT" });
    await assert.rejects(() => access(workflowPath), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer draft requires githubRepo", async () => {
  const { renderNorthstarConfigDraft } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-draft-repo-required-"));

  try {
    await assert.rejects(
      () => renderNorthstarConfigDraft({ projectRoot: dir }),
      /NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED/,
    );

    await assert.rejects(
      () => renderNorthstarConfigDraft({ projectRoot: dir, githubRepo: "   " }),
      /NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer draft rejects malformed githubRepo values", async () => {
  const { renderNorthstarConfigDraft } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-draft-invalid-repo-"));

  try {
    for (const githubRepo of [
      "",
      "   ",
      "owner",
      "owner/repo/extra",
      "owner//repo",
      "/owner/repo",
      "owner/repo\nmalicious",
      "https://github.com/owner/repo.git",
    ]) {
      await assert.rejects(
        () => renderNorthstarConfigDraft({ projectRoot: dir, githubRepo }),
        /NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer requires a supplied or discoverable GitHub repo", async () => {
  const { renderConfigFromCwd } = await import(configRendererModule);
  const { parseRenderConfigArgs } = await import(renderConfigModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-no-repo-"));
  const configPath = join(dir, ".northstar.yaml");

  try {
    await assert.rejects(
      () => renderConfigFromCwd({ cwd: dir }),
      /NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED/,
    );

    const parsed = parseRenderConfigArgs(["--cwd", dir, "--write", "--confirmed"]);
    assert.equal(parsed.cwd, dir);
    assert.equal(parsed.write, true);
    assert.equal(parsed.confirmed, true);
    await assert.rejects(
      () => renderConfigFromCwd(parsed),
      /NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED/,
    );
    await assert.rejects(() => access(configPath), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer discovers repo from local origin inside a git repo", async () => {
  const { renderConfigFromCwd } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-local-origin-"));

  try {
    await git(dir, ["init"]);
    await git(dir, ["config", "--local", "remote.origin.url", "https://github.com/owner/repo.git"]);

    const draft = await renderConfigFromCwd({ cwd: dir });

    assert.match(draft.content, /repo: owner\/repo/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer detects remote default branch when baseBranch is omitted", async () => {
  const { renderConfigFromCwd } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-branch-"));

  try {
    await git(dir, ["init"]);
    await git(dir, ["config", "--local", "remote.origin.url", "https://github.com/owner/repo.git"]);
    await git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);

    const draft = await renderConfigFromCwd({ cwd: dir });

    assert.match(draft.content, /base_branch: trunk/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer does not use current feature branch as default branch", async () => {
  const { renderConfigFromCwd } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-feature-branch-"));

  try {
    await git(dir, ["init"]);
    await git(dir, ["checkout", "-b", "feature/northstar"]);
    await git(dir, ["config", "--local", "remote.origin.url", "https://github.com/owner/repo.git"]);

    const draft = await renderConfigFromCwd({ cwd: dir });

    assert.match(draft.content, /base_branch: main/);
    assert.doesNotMatch(draft.content, /base_branch: feature\/northstar/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer rejects malformed explicit githubRepo inside a git repo", async () => {
  const { renderConfigFromCwd } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-invalid-explicit-origin-"));

  try {
    await git(dir, ["init"]);
    await git(dir, ["config", "--local", "remote.origin.url", "https://github.com/local/origin.git"]);

    for (const githubRepo of [
      "owner/repo/extra",
      "https://github.com/owner/repo.git",
      "owner/repo\nmalicious",
    ]) {
      await assert.rejects(
        () => renderConfigFromCwd({ cwd: dir, githubRepo }),
        /NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer CLI rejects malformed explicit githubRepo without writing", async () => {
  const { parseRenderConfigArgs } = await import(renderConfigModule);
  const { renderConfigFromCwd } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-cli-invalid-explicit-"));
  const configPath = join(dir, ".northstar.yaml");

  try {
    await git(dir, ["init"]);
    await git(dir, ["config", "--local", "remote.origin.url", "https://github.com/local/origin.git"]);

    const parsed = parseRenderConfigArgs([
      "--cwd",
      dir,
      "--github-repo",
      "owner/repo/extra",
      "--write",
      "--confirmed",
    ]);
    assert.equal(parsed.githubRepo, "owner/repo/extra");
    await assert.rejects(
      () => renderConfigFromCwd(parsed),
      /NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED/,
    );
    await assert.rejects(() => access(configPath), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer CLI accepts --json as no-op", async () => {
  const { parseRenderConfigArgs } = await import(renderConfigModule);

  assert.deepEqual(parseRenderConfigArgs(["--github-repo", "owner/repo", "--json"]), {
    githubRepo: "owner/repo",
    write: false,
    confirmed: false,
  });
});

test("northstar config renderer ignores global git origin inside a repo", async () => {
  const { renderConfigFromCwd } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-inside-repo-global-origin-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  const globalGitConfig = join(dir, "global-gitconfig");

  try {
    await mkdir(home);
    await mkdir(repo);
    await writeFile(globalGitConfig, '[remote "origin"]\n\turl = https://github.com/global/repo.git\n', "utf8");
    await git(repo, ["init"], {
      HOME: home,
      GIT_CONFIG_GLOBAL: globalGitConfig,
    });

    await assert.rejects(
      () => renderConfigFromCwd({ cwd: repo }),
      /NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer ignores global git origin outside a repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-global-origin-"));
  const home = join(dir, "home");
  const globalGitConfig = join(dir, "global-gitconfig");
  const script = `
    import { renderConfigFromCwd } from ${JSON.stringify(resolve("skills/northstar/scripts/lib/config-renderer.mjs"))};

    await assertRejects();

    async function assertRejects() {
      try {
        await renderConfigFromCwd({ cwd: ${JSON.stringify(dir)} });
      } catch (error) {
        if (error?.code === "NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED") {
          return;
        }

        throw error;
      }

      throw new Error("renderConfigFromCwd accepted global git origin");
    }
  `;

  try {
    await mkdir(home);
    await writeFile(globalGitConfig, '[remote "origin"]\n\turl = https://github.com/global/wrong.git\n', "utf8");

    await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        HOME: home,
        GIT_CONFIG_GLOBAL: globalGitConfig,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer maybeWriteConfig skips when confirmed false and writes when confirmed true", async () => {
  const { maybeWriteConfig } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-"));
  const configPath = join(dir, "northstar.yaml");
  const workflowPath = join(dir, ".northstar", "workflows", "issue-to-pr-release.yaml");

  try {
    const skipped = await maybeWriteConfig({
      path: configPath,
      content: "skipped",
      workflowPath,
      workflowContent: "workflow-skipped",
      confirmed: false,
    });
    assert.deepEqual(skipped, { path: configPath, wrote: false, workflowPath, workflowWrote: false });
    await assert.rejects(() => access(configPath), { code: "ENOENT" });
    await assert.rejects(() => access(workflowPath), { code: "ENOENT" });

    const written = await maybeWriteConfig({
      path: configPath,
      content: "written",
      workflowPath,
      workflowContent: "workflow-written",
      confirmed: true,
    });
    assert.deepEqual(written, { path: configPath, wrote: true, workflowPath, workflowWrote: true });
    assert.equal(await readFile(configPath, "utf8"), "written");
    assert.equal(await readFile(workflowPath, "utf8"), "workflow-written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer refuses to overwrite existing config unless explicitly allowed", async () => {
  const { maybeWriteConfig } = await import(configRendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-config-renderer-existing-"));
  const configPath = join(dir, ".northstar.yaml");
  const workflowPath = join(dir, ".northstar", "workflows", "issue-to-pr-release.yaml");
  try {
    await writeFile(configPath, "existing", "utf8");

    await assert.rejects(
      () => maybeWriteConfig({ path: configPath, content: "new", confirmed: true }),
      /NORTHSTAR_CONFIG_RENDER_EXISTING_CONFIG/,
    );
    assert.equal(await readFile(configPath, "utf8"), "existing");

    await mkdir(join(dir, ".northstar", "workflows"), { recursive: true });
    await writeFile(workflowPath, "existing-workflow", "utf8");
    await assert.rejects(
      () => maybeWriteConfig({ path: join(dir, "new-config.yaml"), content: "new", workflowPath, workflowContent: "new-workflow", confirmed: true }),
      /NORTHSTAR_CONFIG_RENDER_EXISTING_WORKFLOW/,
    );
    assert.equal(await readFile(workflowPath, "utf8"), "existing-workflow");

    const written = await maybeWriteConfig({
      path: configPath,
      content: "new",
      workflowPath,
      workflowContent: "new-workflow",
      confirmed: true,
      allowOverwrite: true,
    });
    assert.deepEqual(written, { path: configPath, wrote: true, workflowPath, workflowWrote: true });
    assert.equal(await readFile(configPath, "utf8"), "new");
    assert.equal(await readFile(workflowPath, "utf8"), "new-workflow");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar config renderer parseGitHubRemote supports GitHub remotes and ignores non-GitHub remotes", async () => {
  const { parseGitHubRemote } = await import(configRendererModule);

  assert.equal(parseGitHubRemote("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(parseGitHubRemote("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(parseGitHubRemote("https://example.com/owner/repo.git"), undefined);
  assert.equal(parseGitHubRemote("git@example.com:owner/repo.git"), undefined);
});

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
  });
}
