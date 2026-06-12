export function formatRunStatusSummary(status: {
  canvas: { runId: string | null; status: string };
  runtime: {
    status: string;
    latestProgress?: string;
    executorJobIds: string[];
    runningTaskIds: string[];
  };
}): string {
  return [
    `Run: ${status.canvas.runId ?? "none"}`,
    `Status: ${status.runtime.status}`,
    `Running tasks: ${status.runtime.runningTaskIds.join(", ") || "none"}`,
    `Executor jobs: ${status.runtime.executorJobIds.join(", ") || "none"}`,
    `Latest progress: ${status.runtime.latestProgress ?? "none"}`,
  ].join("\n");
}
