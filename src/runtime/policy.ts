export interface RuntimePolicy {
  githubSyncBlocksLifecycle: boolean;
  quarantineRequiresOperator: boolean;
}

export function defaultRuntimePolicy(): RuntimePolicy {
  return {
    githubSyncBlocksLifecycle: false,
    quarantineRequiresOperator: true,
  };
}
