-- Triage gate: tester feedback lands in To Review ('review') and stays there until the
-- owner moves it to To Fix ('open'). Moving an item to To Fix stamps approved_at, and
-- the redline-sync function only ever hands the CLI rows that have it. So feedback the
-- owner deferred or dismissed straight from To Review never reaches the coding agent
-- either, and undoing a Move to To Fix (back to 'review') withdraws the approval.

alter table feedback.items drop constraint items_status_check;
alter table feedback.items
  add constraint items_status_check check (status in ('review', 'open', 'fixed', 'dismissed', 'deferred')),
  alter column status set default 'review',
  add column approved_at timestamptz;

-- Rows from before the gate were all treated as To Fix, so they count as approved
update feedback.items set approved_at = status_updated_at where status <> 'review';

create function feedback.stamp_approval() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'review' then
    new.approved_at := null;
  elsif new.status = 'open' and new.approved_at is null then
    new.approved_at := now();
  end if;
  return new;
end;
$$;

create trigger items_stamp_approval
  before insert or update on feedback.items
  for each row execute function feedback.stamp_approval();

revoke execute on function feedback.stamp_approval() from public, anon, authenticated;
grant execute on function feedback.stamp_approval() to service_role;

create or replace function feedback.inbox_summary() returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'review',    count(*) filter (where status = 'review'),
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

revoke execute on function feedback.inbox_summary() from public, anon, authenticated;
grant execute on function feedback.inbox_summary() to service_role;
