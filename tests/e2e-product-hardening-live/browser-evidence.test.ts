import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyProductHardeningMetrics } from "./metrics.ts";
import {
  assertBrowserEvidenceMetadata,
  connectCdpForTest,
  parsePngDimensions,
  preserveBrowserEvidenceArtifact,
  writeBrowserEvidence,
} from "./harness.ts";

test("browser evidence writer rejects a fake executable that prints Chrome-like evidence", async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "northstar-product-hardening-browser-"));
  const browserBin = join(consumerRoot, "fake-browser.sh");

  try {
    await writeFile(browserBin, [
      "#!/usr/bin/env sh",
      "case \"$1\" in",
      "  --version) printf '%s\\n' 'Google Chrome 125.0.6422.112'; exit 0 ;;",
      "esac",
      "for arg in \"$@\"; do",
      "  case \"$arg\" in",
      "    --screenshot=*) printf '\\211PNG\\015\\012\\032\\012' > \"${arg#--screenshot=}\" ;;",
      "  esac",
      "done",
      "printf '%s\\n' 'product-hardening-live-browser-pass'",
    ].join("\n"));
    await chmod(browserBin, 0o700);

    await assert.rejects(
      () => writeBrowserEvidence({
        consumerRoot,
        runId: `unit-${Date.now()}`,
        issueUrls: ["https://github.com/owner/repo/issues/1"],
        prUrls: ["https://github.com/owner/repo/pull/2"],
        metrics: emptyProductHardeningMetrics(),
        browserBin,
      }),
      /requires browser automation evidence|did not expose a DevTools endpoint|exited before automation/,
    );
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
});

test("PNG IHDR parser rejects signature-only PNG and accepts valid dimensions", () => {
  assert.equal(parsePngDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null);
  assert.deepEqual(parsePngDimensions(validMinimalPng(3, 2)), { width: 3, height: 2 });
});

test("browser evidence metadata requires automation source, DOM assertion, and screenshot dimensions", () => {
  const valid = {
    source: "cdp",
    browser_name: "Chrome",
    browser_version: "125.0.6422.112",
    dom_assertion: {
      selector: "[data-testid='product-hardening-live-browser-pass']",
      expected_text: "product-hardening-live-browser-pass",
      actual_text: "product-hardening-live-browser-pass",
      passed: true,
    },
    screenshot: {
      path: "/tmp/browser-evidence.png",
      width: 1280,
      height: 800,
    },
  };

  assert.doesNotThrow(() => assertBrowserEvidenceMetadata(valid));
  assert.throws(() => assertBrowserEvidenceMetadata({ ...valid, source: "stdout" }), /automation source/);
  assert.throws(() => assertBrowserEvidenceMetadata({ ...valid, dom_assertion: { ...valid.dom_assertion, passed: false } }), /DOM assertion/);
  assert.throws(() => assertBrowserEvidenceMetadata({ ...valid, screenshot: { ...valid.screenshot, width: 0 } }), /screenshot dimensions/);
});

test("browser evidence artifact survives temp root cleanup with rewritten screenshot path", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "northstar-product-hardening-temp-"));
  const artifactRoot = await mkdtemp(join(tmpdir(), "northstar-product-hardening-artifacts-"));
  const evidenceRoot = join(tempRoot, "consumer/.northstar/runtime/evidence/product-hardening-live");
  const evidencePath = join(evidenceRoot, "browser-evidence.json");
  const screenshotPath = join(evidenceRoot, "browser-evidence.png");

  try {
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(screenshotPath, validMinimalPng(4, 5));
    await writeFile(evidencePath, JSON.stringify({
      browser_evidence: {
        source: "cdp",
        browser_name: "Chrome",
        browser_version: "125.0.6422.112",
        dom_assertion: {
          selector: "[data-testid='product-hardening-live-browser-pass']",
          expected_text: "product-hardening-live-browser-pass",
          actual_text: "product-hardening-live-browser-pass",
          passed: true,
        },
        screenshot: {
          path: screenshotPath,
          width: 4,
          height: 5,
        },
      },
    }));

    const preservedPath = await preserveBrowserEvidenceArtifact({
      browserEvidencePath: evidencePath,
      runId: "unit-run",
      artifactRoot,
    });
    await rm(tempRoot, { recursive: true, force: true });

    const preserved = JSON.parse(await readFile(preservedPath, "utf8")) as {
      browser_evidence: { screenshot: { path: string } };
    };
    await stat(preservedPath);
    await stat(preserved.browser_evidence.screenshot.path);
    assert.notEqual(preservedPath.startsWith(tempRoot), true);
    assert.notEqual(preserved.browser_evidence.screenshot.path.startsWith(tempRoot), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("CDP send rejects deterministically when a command response times out", async () => {
  const sent: string[] = [];
  const cdp = await connectCdpForTest("ws://devtools.test", {
    commandTimeoutMs: 5,
    WebSocketCtor: class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = FakeWebSocket.OPEN;

      constructor() {
        super();
        setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }

      send(message: string) {
        sent.push(message);
      }

      close() {
        this.dispatchEvent(new Event("close"));
      }
    },
  });

  await assert.rejects(
    () => cdp.send("Page.enable"),
    /timed out after 5ms/,
  );
  assert.deepEqual(sent.map((message) => JSON.parse(message).method), ["Page.enable"]);
  cdp.close();
});

function validMinimalPng(width: number, height: number): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[24] = 8;
  png[25] = 2;
  png[26] = 0;
  png[27] = 0;
  png[28] = 0;
  png.writeUInt32BE(0, 29);
  return png;
}
