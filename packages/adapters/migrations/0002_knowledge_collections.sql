create table knowledge_collections (
  collection_id text primary key,
  org_id text not null references organizations(org_id),
  parent_collection_id text references knowledge_collections(collection_id),
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  revision bigint not null default 0 check (revision >= 0),
  created_by_principal_id text not null references principals(principal_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_collection_id is null or parent_collection_id <> collection_id)
);

create unique index knowledge_collections_root_name_unique
  on knowledge_collections(org_id, name)
  where parent_collection_id is null;

create unique index knowledge_collections_child_name_unique
  on knowledge_collections(org_id, parent_collection_id, name)
  where parent_collection_id is not null;

create index knowledge_collections_parent_lookup
  on knowledge_collections(org_id, parent_collection_id, collection_id);

create table knowledge_collection_items (
  item_id text primary key references knowledge_items(item_id),
  org_id text not null references organizations(org_id),
  collection_id text not null references knowledge_collections(collection_id),
  placed_by_principal_id text not null references principals(principal_id),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index knowledge_collection_items_collection_lookup
  on knowledge_collection_items(org_id, collection_id, item_id);
