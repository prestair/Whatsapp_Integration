-- Per-worker last-used sheet monitor config, so the cloud dashboard can
-- prefill the form (sheet link, tab, apps script, columns, message, image)
-- instead of asking the user to re-enter everything every time.
-- Run in Supabase SQL Editor after policies_auth.sql.

create table if not exists public.worker_configs (
  worker_id text primary key references public.worker_instances(id) on delete cascade,
  sheet_url text,
  sheet_tab text,
  apps_script_url text,
  phone_column text,
  name_column text,
  status_column text,
  date_column text,
  message text,
  image_path text,
  interval_seconds integer default 120,
  manual_message text,
  manual_image_path text,
  updated_at timestamptz not null default now()
);

alter table public.worker_configs enable row level security;

drop policy if exists auth_read_worker_configs on public.worker_configs;
create policy auth_read_worker_configs on public.worker_configs
  for select to authenticated using (true);

drop policy if exists auth_upsert_worker_configs on public.worker_configs;
create policy auth_upsert_worker_configs on public.worker_configs
  for insert to authenticated with check (true);

drop policy if exists auth_update_worker_configs on public.worker_configs;
create policy auth_update_worker_configs on public.worker_configs
  for update to authenticated using (true) with check (true);

create or replace function public.touch_worker_configs_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists worker_configs_touch_updated_at on public.worker_configs;
create trigger worker_configs_touch_updated_at
before update on public.worker_configs
for each row execute function public.touch_worker_configs_updated_at();
