import { NextResponse, type NextRequest } from "next/server";

const ACTIVE_WEB_PORT = "30141";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const { hostname, port } = parseHost(host);
  const localHost = LOCAL_HOSTS.has(hostname.toLowerCase()) || hostname.toLowerCase().endsWith(".localhost");

  if (localHost && port !== ACTIVE_WEB_PORT) {
    return new NextResponse(
      [
        "This Southstar homepage is disabled.",
        "",
        "Use the active Pi Agent Web UI:",
        "  cd /home/timmypai/apps/southstar/web",
        "  npm run dev",
        "  http://127.0.0.1:30141",
        "",
        `Blocked request host: ${host || "(missing)"}`,
      ].join("\n"),
      {
        status: 421,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      },
    );
  }

  return NextResponse.next();
}

function parseHost(host: string): { hostname: string; port: string } {
  if (!host) return { hostname: "", port: "" };
  if (host.startsWith("[")) {
    const closeBracketIndex = host.indexOf("]");
    if (closeBracketIndex === -1) return { hostname: host, port: "" };
    const hostname = host.slice(0, closeBracketIndex + 1);
    const rest = host.slice(closeBracketIndex + 1);
    return { hostname, port: rest.startsWith(":") ? rest.slice(1) : "" };
  }
  const [hostname, port = ""] = host.split(":");
  return { hostname: hostname ?? "", port };
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
