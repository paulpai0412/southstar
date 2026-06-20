export const SOUTHSTAR_SCHEMA_VERSION = "2026_06_20_managed_agents_work_items_v1";

export const SOUTHSTAR_SCHEMA_SQL = `
create schema if not exists southstar;
create extension if not exists pgcrypto;

create table if not exists southstar.schema_metadata (
  schema_name text primary key,
  version text not null,
  initialized_at timestamptz not null default now()
);

create table if not exists southstar.work_items (
  id text primary key,
  source_provider text not null,
  source_ref text,
  source_url text,
  title text not null,
  domain text not null,
  status text not null,
  run_refs_json jsonb not null default '[]'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists southstar.workflow_runs (
  id text primary key,
  status text not null,
  domain text not null,
  goal_prompt text not null,
  executor_job_id text,
  workflow_manifest_json jsonb not null,
  execution_projection_json jsonb not null,
  snapshot_json jsonb not null,
  runtime_context_json jsonb not null,
  metrics_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists southstar.workflow_tasks (
  id text not null,
  run_id text not null references southstar.workflow_runs(id) on delete cascade,
  task_key text not null,
  status text not null,
  sort_order integer not null,
  depends_on_json jsonb not null,
  root_session_id text,
  subagent_session_ids_json jsonb not null,
  executor_task_id text,
  snapshot_json jsonb not null,
  metrics_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (run_id, id)
);

create table if not exists southstar.workflow_history (
  id text primary key,
  run_id text not null references southstar.workflow_runs(id) on delete cascade,
  task_id text,
  sequence integer not null,
  event_type text not null,
  actor_type text not null,
  session_id text,
  idempotency_key text,
  correlation_id text,
  causation_id text,
  payload_json jsonb not null,
  created_at timestamptz not null default now(),
  unique(run_id, sequence)
);

create table if not exists southstar.runtime_resources (
  id text primary key,
  resource_type text not null,
  resource_key text not null,
  run_id text references southstar.workflow_runs(id) on delete set null,
  task_id text,
  session_id text,
  scope text not null,
  status text not null,
  title text,
  payload_json jsonb not null,
  summary_json jsonb not null default '{}'::jsonb,
  metrics_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  unique(resource_type, resource_key)
);

create table if not exists southstar.artifact_blobs (
  id text primary key,
  resource_id text references southstar.runtime_resources(id) on delete set null,
  run_id text not null references southstar.workflow_runs(id) on delete cascade,
  task_id text,
  session_id text,
  artifact_type text not null,
  content_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  body bytea not null,
  metadata_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists southstar.secure_blobs (
  id text primary key,
  resource_id text not null references southstar.runtime_resources(id) on delete cascade,
  provider text not null,
  key_id text not null,
  ciphertext_blob bytea not null,
  metadata_json jsonb not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table if not exists southstar.library_objects (
  id text primary key,
  object_key text unique not null,
  object_kind text not null,
  status text not null,
  head_version_id text,
  state_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists southstar.library_history (
  id text primary key,
  object_id text not null references southstar.library_objects(id) on delete cascade,
  sequence integer not null,
  event_type text not null,
  actor_type text not null,
  payload_json jsonb not null,
  created_at timestamptz not null default now(),
  unique(object_id, sequence)
);

create table if not exists southstar.library_similarity_index (
  id text primary key,
  object_id text not null references southstar.library_objects(id) on delete cascade,
  signature text not null,
  embedding_json jsonb not null,
  metadata_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists southstar.learning_nodes (
  id text primary key,
  node_type text not null,
  scope text not null,
  status text not null,
  run_id text,
  task_id text,
  session_id text,
  resource_ref text,
  payload_jsonb jsonb not null default '{}'::jsonb,
  summary_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists southstar.learning_edges (
  id text primary key default gen_random_uuid()::text,
  from_node_id text not null references southstar.learning_nodes(id) on delete cascade,
  edge_type text not null,
  to_node_id text not null references southstar.learning_nodes(id) on delete cascade,
  weight double precision not null default 1,
  evidence_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_work_items_source_ref
  on southstar.work_items(source_provider, source_ref)
  where source_ref is not null;
create index if not exists idx_work_items_domain_status
  on southstar.work_items(domain, status);
create index if not exists idx_workflow_runs_status on southstar.workflow_runs(status);
create unique index if not exists idx_workflow_history_idempotency on southstar.workflow_history(run_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_runtime_resources_run_type on southstar.runtime_resources(run_id, resource_type);
create index if not exists idx_runtime_resources_task_type on southstar.runtime_resources(task_id, resource_type);
create index if not exists idx_runtime_resources_session on southstar.runtime_resources(session_id);
create index if not exists idx_library_objects_kind on southstar.library_objects(object_kind);
create index if not exists idx_library_objects_status on southstar.library_objects(status);
create index if not exists idx_library_history_event_type on southstar.library_history(event_type);
create index if not exists idx_library_similarity_signature on southstar.library_similarity_index(signature);
create index if not exists idx_learning_nodes_type_status on southstar.learning_nodes(node_type, status);
create index if not exists idx_learning_nodes_scope on southstar.learning_nodes(scope);
create index if not exists idx_learning_edges_from on southstar.learning_edges(from_node_id, edge_type);
create index if not exists idx_learning_edges_to on southstar.learning_edges(to_node_id, edge_type);

insert into southstar.schema_metadata(schema_name, version)
values ('southstar', '${SOUTHSTAR_SCHEMA_VERSION}')
on conflict(schema_name) do update set version = excluded.version;
`;
