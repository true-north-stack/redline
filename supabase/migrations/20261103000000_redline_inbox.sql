-- Admin inbox support: status-change stamps and a summary RPC.
-- Same access model as the base migration: only service_role touches feedback.*.

alter table feedback.items
  add column status_updated_at timestamptz,
  add column status_updated_by text;

update feedback.items set status_updated_at = created_at where status_updated_at is null;

alter table feedback.items
  alter column status_updated_at set default now(),
  alter column status_updated_at set not null;

create function feedback.stamp_status() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    new.status_updated_at := now();
  end if;
  return new;
end;
$$;

create trigger items_stamp_status
  before update on feedback.items
  for each row execute function feedback.stamp_status();

create index items_status_created_idx on feedback.items (status, created_at desc, id desc);

create function feedback.inbox_summary() returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'open',      count(*) filter (where status = 'open'),
      'fixed',     count(*) filter (where status = 'fixed'),
      'dismissed', count(*) filter (where status = 'dismissed'),
      'deferred',  count(*) filter (where status = 'deferred')
    ),
    'testers', coalesce(
      (select jsonb_agg(t order by t) from (select distinct tester_id as t from feedback.items where tester_id is not null) x),
      '[]'::jsonb),
    'versions', coalesce(
      (select jsonb_agg(v order by v desc) from (select distinct app_version as v from feedback.items where app_version is not null) y),
      '[]'::jsonb)
  )
  from feedback.items;
$$;

revoke execute on function feedback.stamp_status() from public, anon, authenticated;
grant execute on function feedback.stamp_status() to service_role;
revoke execute on function feedback.inbox_summary() from public, anon, authenticated;
grant execute on function feedback.inbox_summary() to service_role;
