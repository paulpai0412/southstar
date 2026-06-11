import { redactSecrets } from "../../src/runtime/redaction.ts";

export interface GitHubFaultRule {
  method: string;
  pathIncludes: string;
  status: number;
  message: string;
}

export function createFaultingGitHubFetch(options: { fail: GitHubFaultRule; fallback?: typeof fetch }): typeof fetch {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    const textUrl = String(url);
    if (method === options.fail.method && textUrl.includes(options.fail.pathIncludes)) {
      return new Response(JSON.stringify({ message: redactLiveExceptionText(options.fail.message) }), {
        status: options.fail.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (options.fallback) return await options.fallback(url, init);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function redactLiveExceptionText(value: string): string {
  return redactSecrets(value).replace(/\bgho_[A-Za-z0-9_]+\b/g, "[REDACTED]");
}
