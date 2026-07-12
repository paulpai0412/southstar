export function runtimeAttemptNumber(value: unknown): number {
  const matches = [...(typeof value === "string" ? value : "").matchAll(/(?:^|-)attempt-(\d+)(?=$|[:_-])/g)];
  const parsed = Number(matches.at(-1)?.[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
