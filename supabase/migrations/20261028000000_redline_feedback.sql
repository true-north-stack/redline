-- Redline feedback storage (opt-in Supabase adapter).
--
-- Access model: only service_role touches this schema and the bucket. The host's
-- API route writes with the secret key on the server; testers never read anything
-- back. anon / authenticated get no grants, and RLS is on with no policies as a
-- second lock. Add "feedback" to the project's exposed schemas so the route and
-- the purge function can reach it through the Data API.

create schema if not exists feedback;

create table feedback.items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  tester_id text,
  page_url text not null,
  element_selector text not null default '',
  element_text text,
  feedback text not null,
  screenshot_path text,
  ux_review_requested boolean not null default false,
  app_version text,
  user_agent text,
  status text not null default 'open'
    check (status in ('open', 'fixed', 'dismissed', 'deferred'))
);

comment on table feedback.items is 'Redline tester feedback. PHI is masked client-side before it gets here; purged after expires_at.';

create index items_expires_at_idx on feedback.items (expires_at);
create index items_created_at_idx on feedback.items (created_at);

alter table feedback.items enable row level security;

revoke all on schema feedback from public, anon, authenticated;
revoke all on all tables in schema feedback from public, anon, authenticated;
grant usage on schema feedback to service_role;
grant select, insert, update, delete on feedback.items to service_role;

-- Private bucket for masked screenshots. No storage.objects policies: only
-- service_role (which bypasses RLS) can upload, read or delete.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('redline-screenshots', 'redline-screenshots', false, 10485760, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;
