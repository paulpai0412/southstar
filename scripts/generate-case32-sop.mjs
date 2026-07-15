import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const snapshotRoot = join(root, "artifacts", "case32-browser");
const outputPath = join(snapshotRoot, "southstar-goal-to-dag-sop.zh-TW.html");

const snapshotTitles = {
  "01-workflow-cwd": "選擇 Workflow 專案目錄",
  "02-goal-submitted": "送出一個 Goal prompt",
  "03-requirements-review": "Requirement 清單審查",
  "04-requirement-editor": "編輯 Requirement 與 UI contract",
  "04-ui-contract-review": "確認 UI interaction contract",
  "04-ui-contracts-confirmed": "完成 UI contract 確認",
  "05-requirement-validation-progress": "Requirement validation 與 candidate resolution",
  "05-requirements-confirmed": "Requirement 確認完成",
  "06-library-import-candidates": "審查 Library import candidates",
  "07-library-install-progress": "安裝並同步 Library graph",
  "08-library-auto-resumed": "安裝後自動續接 Goal validation",
  "09-slice-plan-ready": "Slice plan ready for review",
  "10-slice-sidecar": "在右側 sidecar 編輯 Slice",
  "11-dag-composed": "Composer 產生 DAG",
  "12-run-created": "建立 workflow run",
  "13-execution-started": "Operator 介面核准並開始執行",
  "14-run-completed": "Workflow run 完成",
  "15-goal-satisfied": "Goal outcome satisfied",
  "16-workspace-acceptance": "Workspace source、測試與交付證據",
};

const snapshotOrder = Object.keys(snapshotTitles);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function imageMime(path) {
  const extension = extname(path).toLowerCase();
  return extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
}

async function readOptional(path, fallback = "") {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

async function imageData(path) {
  try {
    const content = await readFile(path);
    return `data:${imageMime(path)};base64,${content.toString("base64")}`;
  } catch {
    return null;
  }
}

async function snapshotCards() {
  const files = new Set(await readdir(snapshotRoot));
  const cards = [];
  for (const key of snapshotOrder) {
    const textPath = join(snapshotRoot, `${key}.txt`);
    const imagePath = join(snapshotRoot, `${key}.png`);
    if (!files.has(`${key}.txt`) && !files.has(`${key}.png`)) continue;
    const text = await readOptional(textPath, "此步驟沒有文字 snapshot；請以畫面為準。");
    const image = await imageData(imagePath);
    cards.push({ key, title: snapshotTitles[key], text, image });
  }
  return cards;
}

function renderSnapshot(card, index) {
  const image = card.image
    ? `<figure class="evidence"><img src="${card.image}" alt="${escapeHtml(card.title)} 的 Case32 真實操作畫面"><figcaption>圖 ${index + 1}｜${escapeHtml(card.title)}（Case32 browser snapshot）</figcaption></figure>`
    : "";
  return `<article class="snapshot" id="snapshot-${escapeHtml(card.key)}">
    <div class="snapshot-heading"><span class="step-number">${String(index + 1).padStart(2, "0")}</span><div><h3>${escapeHtml(card.title)}</h3><p class="mono">${escapeHtml(card.key)}</p></div></div>
    ${image}
    <details><summary>查看此步驟的 DOM/text snapshot</summary><pre>${escapeHtml(card.text)}</pre></details>
  </article>`;
}

const cards = await snapshotCards();
const generatedAt = new Date().toISOString();
const completed = cards.some((card) => card.key === "15-goal-satisfied");
const evidenceSummary = completed
  ? "最後一輪 snapshot 包含 Goal outcome satisfied，表示 evaluator 已完成 requirement coverage 驗證。"
  : "目前 snapshot 尚未包含最後的 satisfied 畫面；請先完成 Case32，再重新產生本 SOP。";

const html = `<!doctype html>
<html lang="zh-Hant-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Southstar Goal-to-DAG 操作 SOP</title>
  <style>
    :root { --ink:#253238; --muted:#66777d; --paper:#f8f7f1; --paper-2:#efeee6; --accent:#a2472f; --line:#c9c8bb; --good:#26734d; --code:#202b2f; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; color:var(--ink); background:var(--paper); font-family: Georgia, "Noto Serif TC", serif; line-height:1.75; }
    body:before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.2; background-image:radial-gradient(#7e877c 0.5px, transparent 0.5px); background-size:5px 5px; mix-blend-mode:multiply; }
    main { width:min(1180px, calc(100% - 48px)); margin:0 auto; position:relative; }
    header.hero { min-height:560px; padding:96px 8vw 72px; display:grid; grid-template-columns:1.4fr .8fr; gap:48px; align-items:end; border-bottom:1px solid var(--line); }
    .eyebrow { color:var(--accent); text-transform:uppercase; letter-spacing:.18em; font:600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
    h1 { margin:18px 0 12px; font-size:clamp(42px, 7vw, 86px); line-height:.98; letter-spacing:-.045em; font-weight:500; }
    h2 { margin:72px 0 16px; font-size:clamp(28px,4vw,48px); line-height:1.12; font-weight:500; }
    h3 { margin:0; font-size:24px; line-height:1.25; font-weight:600; }
    p { max-width:74ch; }
    .lead { font-size:20px; color:#394b50; max-width:60ch; }
    .hero-note { border-left:3px solid var(--accent); padding:18px 22px; background:rgba(255,255,255,.35); }
    nav.toc { position:sticky; top:0; z-index:3; background:rgba(248,247,241,.93); backdrop-filter:blur(8px); border-bottom:1px solid var(--line); padding:12px 0; }
    nav.toc ol { display:flex; flex-wrap:wrap; gap:8px 20px; margin:0; padding:0; list-style:none; font-size:14px; }
    nav.toc a { color:var(--accent); text-decoration:none; border-bottom:1px dotted var(--accent); }
    section { padding-top:1px; }
    .summary { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin:28px 0 42px; }
    .summary > div { border-top:2px solid var(--ink); padding:12px 2px; }
    .summary b { display:block; font:600 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--accent); text-transform:uppercase; letter-spacing:.09em; }
    .summary span { display:block; margin-top:5px; font-size:18px; }
    .diagram { margin:28px 0; padding:20px; background:var(--paper-2); border:1px solid var(--line); overflow:auto; }
    .diagram svg { display:block; width:100%; min-width:760px; height:auto; }
    table { width:100%; border-collapse:collapse; margin:24px 0; font-size:15px; }
    th,td { border-bottom:1px solid var(--line); padding:11px 10px; text-align:left; vertical-align:top; }
    th { color:var(--accent); font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
    .callout { border-left:4px solid var(--accent); background:rgba(162,71,47,.08); padding:14px 18px; margin:24px 0; }
    .callout.good { border-color:var(--good); background:rgba(38,115,77,.08); }
    .mono, pre { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
    .mono { font-size:12px; color:var(--muted); }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; background:#e7e5da; padding:2px 5px; border-radius:3px; }
    pre { white-space:pre-wrap; max-height:360px; overflow:auto; color:#e6eceb; background:var(--code); padding:16px; border-radius:4px; font-size:11px; line-height:1.45; }
    .snapshots { display:grid; gap:32px; }
    .snapshot { border-top:1px solid var(--line); padding-top:24px; }
    .snapshot-heading { display:flex; gap:16px; align-items:flex-start; margin-bottom:14px; }
    .step-number { display:grid; place-items:center; width:38px; height:38px; border:1px solid var(--accent); color:var(--accent); font:600 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    figure.evidence { margin:20px 0; }
    figure.evidence img { display:block; width:100%; max-height:680px; object-fit:contain; object-position:left top; background:#fff; border:1px solid var(--line); }
    figcaption { margin-top:8px; color:var(--muted); font-size:13px; }
    details { margin:14px 0; }
    summary { cursor:pointer; color:var(--accent); font-size:14px; }
    footer { margin:80px 0 50px; border-top:1px solid var(--line); padding-top:18px; color:var(--muted); font-size:13px; }
    @media (max-width:760px) { main { width:min(100% - 28px, 1180px); } header.hero { min-height:auto; padding:60px 0 48px; display:block; } .hero-note { margin-top:30px; } .summary { grid-template-columns:1fr; } h2 { margin-top:52px; } nav.toc ol { gap:6px 12px; } }
  </style>
</head>
<body>
<main>
  <header class="hero" id="top">
    <div>
      <div class="eyebrow">Southstar · Browser SOP · Case32</div>
      <h1>從 Goal 到<br>可執行 DAG</h1>
      <p class="lead">一份以真實 browser E2E 操作整理的中文版上手指南：把一句 Goal prompt，經過 Requirement 審查、Library graph 驗證、Slice plan、DAG composer、Operator approval 與 evaluator，落成可追蹤的完成結果。</p>
    </div>
    <aside class="hero-note"><b>本文件的證據邊界</b><p>所有操作畫面來自本次 Case32 的 Playwright snapshots；文字 snapshot 亦保留在每一步下方，便於稽核與重現。</p><p class="mono">Generated ${escapeHtml(generatedAt)} · ${cards.length} snapshots</p></aside>
  </header>
  <nav class="toc" aria-label="目錄"><ol><li><a href="#orientation">先理解系統</a></li><li><a href="#architecture">架構</a></li><li><a href="#flow">端到端流程</a></li><li><a href="#ui">UI 操作</a></li><li><a href="#evidence">實際操作畫面</a></li><li><a href="#acceptance">驗收與排錯</a></li></ol></nav>

  <section id="orientation">
    <h2>先理解這個系統在做什麼</h2>
    <p>Southstar 不是把 prompt 直接轉成一串命令，而是把「使用者想完成的事情」變成一組可審查、可驗證、可持久化的 runtime objects。Goal Contract 保存原始目標與 requirement；Library graph 提供已核准的 agent、skill、tool、MCP、artifact 與 evaluator；Composer 只負責組合，不負責自行發明驗證真相。</p>
    <div class="summary"><div><b>輸入</b><span>一個 Goal prompt + CWD</span></div><div><b>中間產物</b><span>Requirement / Slice plan / Manifest</span></div><div><b>輸出</b><span>Run status + evidence + evaluator outcome</span></div></div>
    <div class="callout"><strong>重要原則：</strong>artifact 與 evaluator 是可重用的 graph objects，不以 Goal domain 作硬 scope filter。跨 product、testing 或其他 scope 的 pair，只要 approved 且有版本固定的 <code>validates_artifact</code> edge，就可以被正確解析。</div>
  </section>

  <section id="architecture">
    <h2>系統架構</h2>
    <p>瀏覽器只操作 UI API；runtime server 負責持久化與控制；Postgres 保存 lifecycle truth；Tork/Pi 執行 task；evaluator 以 artifact contract 與 requirement acceptance criteria 判斷是否完成。</p>
    <div class="diagram" role="img" aria-label="Southstar 系統架構圖"><svg viewBox="0 0 1000 300" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L9,3 L0,6 Z" fill="#a2472f"/></marker></defs><g font-family="Georgia,serif" font-size="18" fill="#253238" text-anchor="middle"><rect x="30" y="100" width="150" height="70" rx="4" fill="#fff" stroke="#a2472f"/><text x="105" y="132">Browser UI</text><text x="105" y="155" font-size="13">Goal / Library / Operator</text><rect x="240" y="100" width="170" height="70" rx="4" fill="#fff" stroke="#a2472f"/><text x="325" y="132">Runtime API</text><text x="325" y="155" font-size="13">orchestration + commands</text><rect x="470" y="65" width="190" height="140" rx="4" fill="#efeee6" stroke="#253238"/><text x="565" y="104">Postgres</text><text x="565" y="130" font-size="13">Goal Contract</text><text x="565" y="151" font-size="13">DAG / tasks / history</text><text x="565" y="172" font-size="13">Library graph / evidence</text><rect x="720" y="35" width="120" height="70" rx="4" fill="#fff" stroke="#26734d"/><text x="780" y="67">Tork</text><text x="780" y="89" font-size="13">executor</text><rect x="720" y="160" width="120" height="70" rx="4" fill="#fff" stroke="#26734d"/><text x="780" y="192">Pi</text><text x="780" y="214" font-size="13">agent runner</text><rect x="890" y="100" width="80" height="70" rx="4" fill="#fff" stroke="#26734d"/><text x="930" y="132">Eval</text><text x="930" y="154" font-size="13">AC</text></g><g stroke="#a2472f" stroke-width="2" fill="none" marker-end="url(#arrow)"><path d="M180 135 H240"/><path d="M410 135 H470"/><path d="M660 100 H720"/><path d="M660 170 H720"/><path d="M840 135 H890"/></g></svg></div>
    <table><thead><tr><th>層</th><th>責任</th><th>使用者看到的結果</th></tr></thead><tbody><tr><td>Goal / orchestration</td><td>解析需求、產生 requirement、執行 validation closure</td><td>Requirement 清單、candidate gap、slice plan</td></tr><tr><td>Library graph</td><td>保存 approved object、版本與 edge；跨 scope 關係由 edge 決定</td><td>可審查的 import candidate 與 graph</td></tr><tr><td>Composer / manifest</td><td>把已確認 slice 與 validation binding 組成 canonical DAG</td><td>DAG node、dependencies、artifact/evaluator binding</td></tr><tr><td>Executor / operator</td><td>排程、Tork/Pi 執行、approval、heartbeat、callback、recovery</td><td>Run 狀態、task 狀態、可操作命令</td></tr><tr><td>Evaluator</td><td>依 requirement AC 與 artifact evidence 判定 coverage/outcome</td><td>satisfied 或 unsatisfied，並可追溯到 evidence</td></tr></tbody></table>
  </section>

  <section id="flow">
    <h2>端到端流程：一個 prompt 如何變成可驗證結果</h2>
    <ol><li><strong>選 CWD：</strong>在 Workflow panel 指定實際 workspace；所有後續 snapshot、task 與 operator filter 都綁定此目錄。</li><li><strong>送出 Goal：</strong>只送一次 prompt。Goal interpreter 產生 Goal Contract 與 reviewable Requirement list，不立即建立 DAG。</li><li><strong>確認 Requirement：</strong>逐項查看 statement、功能、acceptance criteria、expected artifact、verification intent；需要 UI 的 requirement 可打開 interaction contract 編輯/確認。</li><li><strong>Validation：</strong>host 先以 approved graph、artifact/evaluator edge、版本與 evidence schema 做 deterministic checks；LLM 只負責語義 rank 與 proposal。</li><li><strong>Library review：</strong>若缺 pair，畫面列出 candidate；使用者安裝後，系統同步 file → graph，並以同一個 Goal draft 自動續接，不重新輸入 prompt。</li><li><strong>Slice plan：</strong>Requirement 轉成可審查 slices；每個 slice 有 scope、strategy、producer/evaluator coverage、dependencies 與 deliverables。</li><li><strong>Composer：</strong>確認 slice plan 後，LLM composer 產生 DAG；host 驗證 nodePromptSpec、candidate refs、artifact/evaluator version 與 manifest。</li><li><strong>Operator approval：</strong>高風險 run 會停在 awaiting approval；Operator state dashboard 顯示 Approve，確認 reason 後才進 scheduling。等待 approval 的 run 也會被 Operator 查詢與輪詢。</li><li><strong>Executor：</strong>scheduler 將 runnable task 送到 Tork/Pi，callback 將 heartbeat、artifact、history 與 task snapshot 持久化。</li><li><strong>Evaluator：</strong>所有 blocking requirement 的 evidence 被聚合，evaluator 依 AC 判定 outcome；最後 Goal mission 顯示 satisfied 或 unsatisfied。</li></ol>
    <div class="callout good"><strong>成功判準：</strong>不是「DAG 產生了」而已，而是 run 完成、每個 blocking requirement 有 coverage、artifact/evaluator evidence 通過，且 Goal outcome 為 satisfied。</div>
  </section>

  <section id="ui">
    <h2>UI 操作說明</h2>
    <table><thead><tr><th>Panel</th><th>你要做的事</th><th>完成條件</th></tr></thead><tbody><tr><td>Workflow</td><td>選 CWD、輸入 Goal、確認 Requirement、查看 slice plan、點選 slice 在 sidecar 編輯、按 Compose</td><td>顯示 DAG 與 run created</td></tr><tr><td>Library</td><td>查看候選 object、確認 artifact/evaluator schema、勾選並 Install selected candidates、檢查 graph</td><td>candidate block 消失，Goal 自動續接 validation；不會出現第二輪 review</td></tr><tr><td>Operator</td><td>查看 state dashboard；若 run 為 awaiting_approval，輸入 reason 並按 Approve；觀察 task 與 outcome</td><td>run 進 scheduling/running，最後顯示 completed 與 satisfied</td></tr><tr><td>Sidecar</td><td>查看 requirement/slice/UI contract 的詳細欄位與可編輯內容</td><td>確認後回到同一個 Goal draft，hash 與 revision 可追蹤</td></tr></tbody></table>
  </section>

  <section id="evidence"><h2>實際操作畫面與可驗證證據</h2><p>${escapeHtml(evidenceSummary)}</p><div class="snapshots">${cards.map(renderSnapshot).join("\n")}</div></section>

  <section id="acceptance"><h2>驗收與排錯</h2><table><thead><tr><th>症狀</th><th>先看哪裡</th><th>正確判斷</th></tr></thead><tbody><tr><td>看不到 candidate</td><td>Requirement validation progress、Library graph readiness</td><td>可能已經有 approved pair；不是錯誤。若 artifact/evaluator 跨 scope，仍應由 edge 綁定。</td></tr><tr><td>安裝後又出現第二輪 Library review</td><td><code>goal_validation_resume</code> resource 與 import draft coverage</td><td>檢查 approved version、active validates edge、evidenceKinds 與 proposal coverage；不可用 Goal domain 排除 pair。</td></tr><tr><td>Run 停在 awaiting approval</td><td>Operator state dashboard</td><td>這是風險控制，不是 executor hang；按 Approve 後才 scheduling。</td></tr><tr><td>Evaluator unsatisfied</td><td>Goal outcome、requirement coverage、artifact/evaluator result</td><td>檢查 evidence 是否真的來自 producer task，及是否符合 requirement 的 AC；不要用 generic implementation report 代替 domain artifact。</td></tr></tbody></table><p class="mono">重新產生本文件：<code>node scripts/generate-case32-sop.mjs</code>。本文件會重新嵌入目前 artifacts/case32-browser 下的 PNG 與 text snapshots，保持單檔離線可讀。</p></section>
  <footer>Southstar Goal-to-DAG 操作 SOP · 由真實 Case32 browser E2E snapshots 產生 · ${escapeHtml(generatedAt)}</footer>
</main>
</body>
</html>`;

await writeFile(outputPath, html, "utf8");
console.log(`wrote ${outputPath} (${cards.length} snapshots, ${html.length} bytes)`);
