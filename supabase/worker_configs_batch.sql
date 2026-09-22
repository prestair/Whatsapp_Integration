-- Adds batch size/gap columns to the existing worker_configs table.
-- Run in Supabase SQL Editor after worker_configs.sql.
alter table public.worker_configs
  add column if not exists batch_size integer default 5,
  add column if not exists batch_gap_seconds integer default 10;
