alter table agent_tasks
  add column a2a_projection_state text not null default 'pending',
  add column a2a_projection_version bigint not null default 0,
  add column a2a_projection_error_code text,
  add constraint agent_tasks_a2a_projection_state_check
    check (a2a_projection_state in ('pending', 'completed', 'failed')),
  add constraint agent_tasks_a2a_projection_version_check
    check (a2a_projection_version >= 0),
  add constraint agent_tasks_a2a_projection_error_check
    check (
      (a2a_projection_state = 'failed' and a2a_projection_error_code = 'INVALID_A2A_PROJECTION')
      or (a2a_projection_state <> 'failed' and a2a_projection_error_code is null)
    );

create index agent_tasks_a2a_projection_pending_idx
  on agent_tasks(created_at, task_id)
  where state = 'completed'
    and output_json is not null
    and a2a_projection_state = 'pending';
