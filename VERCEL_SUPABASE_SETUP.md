# Vercel frontend + Supabase control plane + local WhatsApp worker

## Architecture

```text
Vercel dashboard (public/config.js)
        ↓ browser API calls / Socket.IO
Local Node worker (server.js)
        ↓ optional Supabase REST control plane
Supabase tables + Storage
        ↓
Baileys WhatsApp session + Google Sheet monitor
```

The local worker is still the only process that owns the WhatsApp session. It must be running when messages or monitoring are needed. Supabase and Vercel do not replace Baileys.

## Local worker setup

1. Copy `.env.example` to `.env`.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only if using the control plane.
3. Run `supabase/schema.sql` in the Supabase SQL Editor.
4. Start the worker:

```powershell
npm install
npm start
```

Without Supabase variables, the existing local JSON/config behavior remains available. With Supabase variables, the worker registers in `worker_instances` and polls `monitor_commands`.

## Vercel frontend setup

1. Import this repository into Vercel.
2. Use the repository root as the project root.
3. `vercel.json` serves the `public/` directory as a static site.
4. Edit `public/config.js` before deployment, or replace it during your deployment process:

```js
window.APP_CONFIG = {
  backendUrl: 'https://YOUR-BACKEND-OR-TUNNEL-URL',
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  supabaseAnonKey: 'YOUR_PUBLIC_ANON_KEY'
};
```

`backendUrl` must point to the machine running `server.js` if remote users should operate this existing API. It must be HTTPS in production. `SUPABASE_SERVICE_ROLE_KEY` must never be placed in `public/config.js` or a browser/Vercel public variable.

The frontend is API-configurable and sends monitor heartbeats. When its owning page closes, it sends a best-effort stop beacon. The worker-side lease timeout is the reliable fallback for crashes and forced shutdowns.

## Supabase command flow

A future authenticated frontend can insert a row into `monitor_commands` for the local worker:

```sql
insert into public.monitor_commands (worker_id, command_type, payload)
values (
  'office-whatsapp-worker',
  'start_monitoring',
  '{"sheetUrl":"https://docs.google.com/spreadsheets/d/ID/edit","sheetTab":"Sheet1","phoneColumn":"phone_number","nameColumn":"full_name","statusColumn":"Status","dateColumn":"Date","message":"Hello {name}","intervalSeconds":120}'::jsonb
);
```

Stop with:

```sql
insert into public.monitor_commands (worker_id, command_type, payload)
values ('office-whatsapp-worker', 'stop_monitoring', '{}'::jsonb);
```

Before allowing browser inserts, add Supabase Auth and owner-specific RLS policies. The schema is deny-by-default for browser access because unrestricted command insertion could send messages or stop another user’s monitor.

## Authentication note

No OTP or WhatsApp reset feature is included. If login is added, use Supabase email/password authentication and owner-scoped RLS. Do not hardcode the service-role key or an administrator password in frontend files.

## Current migration boundary

The current dashboard API, local profile/auth files, local uploads, and JSON history remain in `server.js` for compatibility. The optional control plane currently covers worker registration, monitor commands, monitor sessions, heartbeats, and lease expiry. Moving history/uploads/manual-send jobs fully into Supabase is a separate migration and should be done only after Auth/RLS ownership rules are finalized.
