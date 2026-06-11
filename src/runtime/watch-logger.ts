const secretPatterns = [
  /authorization:\s*bearer/i,
  /gho_[A-Za-z0-9_]+/,
  /github_token/i,
  /api[_-]?key/i,
  /secret/i,
];

export function compactWatchLogLine(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export function containsSecretLeak(value: string): boolean {
  return secretPatterns.some((pattern) => pattern.test(value));
}
