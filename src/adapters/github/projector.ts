export function projectionFailureEvent(
  projection_target: string,
  last_error: string,
  next_retry_at: string,
  options: { attempt?: number; payload?: Record<string, unknown> } = {},
) {
  return {
    type: "projection_result",
    projection_target,
    status: "failed",
    attempt: options.attempt ?? 1,
    last_error,
    next_retry_at,
    payload: options.payload ?? {},
  };
}
