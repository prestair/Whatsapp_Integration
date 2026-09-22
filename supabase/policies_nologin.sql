-- No-login public policies for Design 2A (shared dashboard, no auth yet).
-- WARNING: This allows anyone with the anon key + dashboard URL to read worker
-- status/QR and send commands. Acceptable for a small trusted team to start.
-- Replace with Supabase Auth + owner-scoped policies before wider exposure.

-- Dashboard reads device list + live connection/QR state.
drop policy if exists anon_read_workers on public.worker_instances;
create policy anon_read_workers on public.worker_instances
  for select to anon using (true);

-- Dashboard reads live logs.
drop policy if exists anon_read_events on public.worker_events;
create policy anon_read_events on public.worker_events
  for select to anon using (true);

-- Dashboard reads message history (central reporting).
drop policy if exists anon_read_history on public.message_history;
create policy anon_read_history on public.message_history
  for select to anon using (true);

-- Dashboard creates commands (start/stop monitoring, send message) for a worker.
drop policy if exists anon_insert_commands on public.monitor_commands;
create policy anon_insert_commands on public.monitor_commands
  for insert to anon with check (
    command_type in ('start_monitoring', 'stop_monitoring', 'send_message', 'logout')
  );

-- Dashboard reads command status (to show completed/failed).
drop policy if exists anon_read_commands on public.monitor_commands;
create policy anon_read_commands on public.monitor_commands
  for select to anon using (true);

-- Dashboard reads monitor sessions (to show running state).
drop policy if exists anon_read_sessions on public.monitor_sessions;
create policy anon_read_sessions on public.monitor_sessions
  for select to anon using (true);
