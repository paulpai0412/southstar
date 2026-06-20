export type RunnableTaskSchedulerRunInput = {
  runId: string;
};

export type RunnableTaskSchedulerRunResult = {
  runId: string;
  dispatchedTaskIds: string[];
  skippedTaskIds: Array<{
    taskId: string;
    reason: string;
  }>;
};

export type RunnableTaskSchedulerResult = RunnableTaskSchedulerRunResult;
