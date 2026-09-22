-- Fix: worker_configs should survive worker deletion (Option B deletes the
-- worker_instances row on app shutdown, which was cascade-deleting the saved
-- config and making the form blank on next launch).
-- Remove the foreign key so config persists by worker_id independently.
-- Run in Supabase SQL Editor.

alter table public.worker_configs
  drop constraint if exists worker_configs_worker_id_fkey;
