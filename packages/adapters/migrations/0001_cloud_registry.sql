create extension if not exists pg_trgm;

create table organizations (
  org_id text primary key,
  name text not null,
  registry_revision bigint not null default 0,
  created_at timestamptz not null default now()
);

create table principals (
  principal_id text primary key,
  org_id text not null references organizations(org_id),
  principal_type text not null check (principal_type in ('user', 'agent', 'relay')),
  display_name text not null,
  organization_role text check (organization_role in ('owner', 'member')),
  capabilities text[] not null default '{}',
  status text not null check (status in ('active', 'revoked')),
  created_at timestamptz not null default now()
);

create table principal_tokens (
  token_id text primary key,
  org_id text not null references organizations(org_id),
  principal_id text not null references principals(principal_id),
  token_prefix text not null,
  token_digest bytea not null unique,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table delegations (
  delegation_id text primary key,
  org_id text not null references organizations(org_id),
  agent_principal_id text not null references principals(principal_id),
  user_principal_id text not null references principals(principal_id),
  capabilities text[] not null,
  resource_scopes jsonb not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table connector_instances (
  connector_instance_id text primary key,
  org_id text not null references organizations(org_id),
  connector_type text not null check (connector_type in ('local-folder', 'github', 'feishu', 'codex-history')),
  display_name text not null,
  secret_reference text,
  status text not null check (status in ('active', 'disabled')),
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table source_authorizations (
  source_authorization_id text primary key,
  org_id text not null references organizations(org_id),
  connector_instance_id text not null references connector_instances(connector_instance_id),
  source_id text not null,
  authorization_hash text not null,
  authorization_json jsonb not null,
  approval_receipt_json jsonb not null,
  status text not null check (status in ('active', 'revoked')),
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (org_id, source_id, authorization_hash)
);

create table knowledge_items (
  item_id text primary key,
  org_id text not null references organizations(org_id),
  owner_principal_id text not null references principals(principal_id),
  title text not null,
  aliases text[] not null default '{}',
  status text not null check (status in ('draft', 'stable', 'deprecated')),
  current_version_id text,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table knowledge_locations (
  location_id text primary key,
  org_id text not null references organizations(org_id),
  item_id text not null references knowledge_items(item_id),
  location_kind text not null check (location_kind in ('managed-markdown', 'feishu', 'github', 'person-local')),
  location_role text not null check (location_role in ('canonical', 'original', 'managed-copy', 'reference')),
  locator text not null,
  connector_instance_id text references connector_instances(connector_instance_id),
  source_authorization_id text references source_authorizations(source_authorization_id),
  owner_principal_id text not null references principals(principal_id),
  metadata jsonb not null default '{}',
  observed_provider_version text,
  availability text not null check (availability in ('available', 'offline', 'unknown', 'revoked')),
  revision bigint not null default 0,
  last_verified_at timestamptz,
  unique (org_id, locator)
);

create table knowledge_versions (
  version_id text primary key,
  org_id text not null references organizations(org_id),
  item_id text not null references knowledge_items(item_id),
  location_id text not null references knowledge_locations(location_id),
  ordinal integer not null check (ordinal > 0),
  body_hash text not null,
  body_markdown text check (octet_length(body_markdown) <= 1048576),
  provider_version text,
  provenance jsonb not null,
  created_by_principal_id text not null references principals(principal_id),
  created_at timestamptz not null default now(),
  unique (location_id, ordinal)
);

alter table knowledge_items
  add constraint knowledge_items_current_version_fk
  foreign key (current_version_id) references knowledge_versions(version_id);

create table tags (
  tag_id text primary key,
  org_id text not null references organizations(org_id),
  name text not null,
  description text not null default '',
  unique (org_id, name)
);

create table knowledge_tags (
  org_id text not null references organizations(org_id),
  item_id text not null references knowledge_items(item_id),
  tag_id text not null references tags(tag_id),
  version_id text references knowledge_versions(version_id),
  primary key (org_id, item_id, tag_id)
);

create table resource_grants (
  grant_id text primary key,
  org_id text not null references organizations(org_id),
  principal_id text not null references principals(principal_id),
  scope_kind text not null check (scope_kind in ('organization', 'item', 'source', 'tag')),
  scope_id text not null,
  capabilities text[] not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table presence_leases (
  relay_principal_id text primary key references principals(principal_id),
  org_id text not null references organizations(org_id),
  owner_principal_id text not null references principals(principal_id),
  capabilities text[] not null,
  lease_expires_at timestamptz not null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table agent_sessions (
  session_id text primary key,
  org_id text not null references organizations(org_id),
  owner_principal_id text not null references principals(principal_id),
  history_json jsonb not null default '[]',
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table agent_tasks (
  task_id text primary key,
  context_id text not null,
  org_id text not null references organizations(org_id),
  owner_principal_id text not null references principals(principal_id),
  actor_agent_id text references principals(principal_id),
  delegation_id text references delegations(delegation_id),
  state text not null check (state in ('submitted', 'working', 'input-required', 'completed', 'failed', 'canceled')),
  input_json jsonb not null,
  output_json jsonb,
  a2a_task_json jsonb,
  run_state text,
  error_code text,
  cancel_requested boolean not null default false,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_events (
  audit_event_id text primary key,
  org_id text not null references organizations(org_id),
  task_id text,
  actor_principal_id text not null,
  on_behalf_of_user_id text not null,
  action text not null,
  target_kind text not null,
  target_id text not null,
  decision text not null check (decision in ('allowed', 'denied', 'completed', 'failed')),
  receipt_metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index knowledge_items_title_trgm_idx on knowledge_items using gin (title gin_trgm_ops);
create index knowledge_versions_body_fts_idx on knowledge_versions using gin (to_tsvector('simple', coalesce(body_markdown, '')));
create index resource_grants_lookup_idx on resource_grants (org_id, principal_id, scope_kind, scope_id);
create index agent_tasks_recovery_idx on agent_tasks (state, updated_at);
create index audit_events_target_idx on audit_events (org_id, target_kind, target_id, created_at);
