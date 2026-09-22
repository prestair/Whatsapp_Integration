-- Lock the dashboard to logged-in (authenticated) users only.
-- Run AFTER schema.sql, schema_2a.sql, and policies_nologin.sql.
-- This DROPS the open anon policies and replaces them with authenticated-only
-- access. The local worker keeps full access via the service-role key (bypasses RLS).

-- Remove the previous no-login (anon) policies.
drop policy if exists anon_read_workers   on public.worker_instances;
drop policy if exists anon_read_events     on public.worker_events;
drop policy if exists anon_read_history    on public.message_history;
drop policy if exists anon_insert_commands on public.monitor_commands;
drop policy if exists anon_read_commands   on public.monitor_commands;
drop policy if exists anon_read_sessions   on public.monitor_sessions;

-- Authenticated (logged-in) team members: read device list + live state.
drop policy if exists auth_read_workers on public.worker_instances;
create policy auth_read_workers on public.worker_instances
  for select to authenticated using (true);

-- Read live logs.
drop policy if exists auth_read_events on public.worker_events;
create policy auth_read_events on public.worker_events
  for select to authenticated using (true);

-- Read message history (central reporting).
drop policy if exists auth_read_history on public.message_history;
create policy auth_read_history on public.message_history
  for select to authenticated using (true);

-- Create commands (start/stop monitoring, send message, logout).
drop policy if exists auth_insert_commands on public.monitor_commands;
create policy auth_insert_commands on public.monitor_commands
  for insert to authenticated with check (
    command_type in ('start_monitoring', 'stop_monitoring', 'send_message', 'logout')
  );

-- Read command status.
drop policy if exists auth_read_commands on public.monitor_commands;
create policy auth_read_commands on public.monitor_commands
  for select to authenticated using (true);

-- Read monitor sessions.
drop policy if exists auth_read_sessions on public.monitor_sessions;
create policy auth_read_sessions on public.monitor_sessions
  for select to authenticated using (true);
