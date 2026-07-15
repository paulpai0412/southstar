/**
 * Host-level safety boundary for generated execution profiles.
 *
 * Provider/model/harness/image values are runtime bindings supplied by the
 * configured host. They must not be frozen here because library composition
 * is expected to work with more than the local Pi image. The runner command
 * remains fixed because it is the Southstar executor boundary, not a model
 * selection policy.
 */
export const GENERATED_AGENT_PROFILE_COMMAND_ENTRYPOINT = "southstar-agent-runner";
