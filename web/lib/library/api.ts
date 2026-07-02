import type { LibraryFileEnvelope, LibraryFileSyncResult } from "./types";

export function unwrapEnvelope<T>(payload: unknown): T {
  if (!payload || typeof payload !== "object") {
    throw new Error("API response is not an object");
  }

  const record = payload as { ok?: unknown; result?: unknown; error?: unknown };
  if (record.ok !== true) {
    throw new Error(typeof record.error === "string" ? record.error : "API request failed");
  }

  return record.result as T;
}

export async function readLibraryFile(relativePath: string): Promise<LibraryFileEnvelope> {
  return requestLibraryJson<LibraryFileEnvelope>(libraryFileUrl(relativePath));
}

export async function saveLibraryFile(relativePath: string, content: string): Promise<LibraryFileEnvelope> {
  return requestLibraryJson<LibraryFileEnvelope>(libraryFileUrl(relativePath), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export async function syncLibraryFile(relativePath: string): Promise<LibraryFileSyncResult> {
  return requestLibraryJson<LibraryFileSyncResult>(`${libraryFileUrl(relativePath)}/sync`, {
    method: "POST",
  });
}

async function requestLibraryJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text || "API request failed"}`);
    }
    throw new Error(`Invalid JSON response from ${url}`);
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : text || response.statusText || "API request failed";
    throw new Error(`${response.status} ${response.statusText}: ${message}`);
  }
  return unwrapEnvelope<T>(payload);
}

function libraryFileUrl(relativePath: string): string {
  return `/api/library/files/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}
