# Supabase control-plane setup

This project keeps the Baileys WhatsApp session and the monitor worker on the Windows computer. Supabase stores worker status, monitor commands/sessions, and (after the full data migration) message history. Vercel can host the dashboard frontend.

## 1. Create the project

Create a Supabase project, open **SQL Editor**, and run `supabase/schema.sql`.

Do not put the Supabase service-role key in browser code or in a public Vercel environment variable. The service-role key belongs only on the local worker.

## 2. Configure the local worker

Copy `.env.example` to `.env` and set:

```text
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
CONTROL_PLANE_WORKER_ID=office-whatsapp-worker
```

The current server remains backward-compatible: without these variables it runs exactly as the existing local app. With them, it registers the worker and polls `monitor_commands`.

## 3. Commands from a frontend

A trusted authenticated frontend can insert commands into `monitor_commands`:

```json
{
  "worker_id": "office-whatsapp-worker",
  "command_type": "start_monitoring",
  "payload": {
    "sheetUrl": "https://docs.google.com/spreadsheets/d/…/edit",
    "sheetTab": "Sheet1",
    "appsScriptUrl": "https://script.google.com/macros/s/…/exec",
    "phoneColumn": "phone_number",
    "nameColumn": "full_name",
    "statusColumn": "Status",
    "dateColumn": "Date",
    "message": "Hello {name}",
    "imagePath": "",
    "intervalSeconds": 120
  }
}
```

Stop with a `stop_monitoring` command and the active `session_id` in `payload`. The worker claims pending commands and marks them completed/failed.

The browser must never write arbitrary commands without Supabase Auth + RLS policies. The schema deliberately starts deny-by-default for browser access.

## 4. Monitoring lease

The local API supports a monitor session lease. The frontend receives `sessionId` and `leaseToken` from `/api/sheet/start`, sends `/api/sheet/heartbeat` every 15 seconds, and sends a best-effort stop through `pagehide`. The worker also expires a Supabase session after the configured lease timeout, which handles browser crashes and forced shutdowns.

## 5. OTP

No OTP or WhatsApp reset flow is included. If authentication is added later, use Supabase email/password auth or another explicitly chosen method; never expose the service-role key in the frontend.
