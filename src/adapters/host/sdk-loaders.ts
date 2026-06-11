export function opencodeSdkPackageName(): "@opencode-ai/sdk" {
  return "@opencode-ai/sdk";
}

export function codexSdkPackageName(): "@openai/codex-sdk" {
  return "@openai/codex-sdk";
}

export function piSdkPackageName(): "@earendil-works/pi-coding-agent" {
  return "@earendil-works/pi-coding-agent";
}

export async function openCodeLoader(): Promise<unknown> {
  return import("@opencode-ai/sdk");
}

export async function codexLoader(): Promise<unknown> {
  return import("@openai/codex-sdk");
}

export async function piLoader(): Promise<unknown> {
  return import("@earendil-works/pi-coding-agent");
}
