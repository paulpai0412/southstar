export const SOUTHSTAR_V2_SCHEMA = `
pragma foreign_keys = on;

create table if not exists workflow_runs (
  id text primary key,
  status text not null,
  domain text not null,
  goal_prompt text not null,
  executor_job_id text,
  workflow_manifest_json text not null,
  execution_projection_json text not null,
  snapshot_json text not null,
  runtime_context_json text not null,
  metrics_json text not null,
  created_at text not null,
  updated_at text not null,
  completed_at text
);

create table if not exists workflow_tasks (
  id text not null,
  run_id text not null references workflow_runs(id),
  task_key text not null,
  status text not null,
  sort_order integer not null,
  depends_on_json text not null,
  root_session_id text,
  subagent_session_ids_json text not null,
  executor_task_id text,
  snapshot_json text not null,
  metrics_json text not null,
  created_at text not null,
  updated_at text not null,
  completed_at text,
  primary key (run_id, id)
);

create table if not exists workflow_history (
  id text primary key,
  run_id text not null references workflow_runs(id),
  task_id text,
  sequence integer not null,
  event_type text not null,
  actor_type text not null,
  session_id text,
  idempotency_key text,
  correlation_id text,
  causation_id text,
  payload_json text not null,
  created_at text not null
);

create table if not exists runtime_resources (
  id text primary key,
  resource_type text not null,
  resource_key text not null,
  run_id text references workflow_runs(id),
  task_id text,
  session_id text,
  scope text not null,
  status text not null,
  title text,
  payload_json text not null,
  summary_json text not null,
  metrics_json text not null,
  created_at text not null,
  updated_at text not null,
  expires_at text,
  unique(resource_type, resource_key)
);

create table if not exists artifact_blobs (
  id text primary key,
  resource_id text references runtime_resources(id),
  run_id text not null references workflow_runs(id),
  task_id text,
  session_id text,
  artifact_type text not null,
  content_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  body blob not null,
  metadata_json text not null,
  created_at text not null
);

create table if not exists secure_blobs (
  id text primary key,
  resource_id text not null references runtime_resources(id),
  provider text not null,
  key_id text not null,
  ciphertext_blob blob not null,
  metadata_json text not null,
  created_at text not null,
  rotated_at text
);

create table if not exists library_objects (
  id text primary key,
  object_key text unique not null,
  object_kind text not null,
  status text not null,
  head_version_id text,
  state_json text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists library_history (
  id text primary key,
  object_id text not null references library_objects(id),
  sequence integer not null,
  event_type text not null,
  actor_type text not null,
  payload_json text not null,
  created_at text not null,
  unique(object_id, sequence)
);

create table if not exists library_similarity_index (
  id text primary key,
  object_id text not null references library_objects(id),
  signature text not null,
  embedding_json text not null,
  metadata_json text not null,
  created_at text not null
);

create index if not exists idx_workflow_runs_status on workflow_runs(status);
create unique index if not exists idx_workflow_history_run_sequence on workflow_history(run_id, sequence);
create unique index if not exists idx_workflow_history_idempotency on workflow_history(run_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_runtime_resources_run_type on runtime_resources(run_id, resource_type);
create index if not exists idx_runtime_resources_task_type on runtime_resources(task_id, resource_type);
create index if not exists idx_runtime_resources_session on runtime_resources(session_id);
create index if not exists idx_library_objects_kind on library_objects(object_kind);
create index if not exists idx_library_objects_status on library_objects(status);
create index if not exists idx_library_history_object_sequence on library_history(object_id, sequence);
create index if not exists idx_library_history_event_type on library_history(event_type);
create index if not exists idx_library_similarity_signature on library_similarity_index(signature);
`;
