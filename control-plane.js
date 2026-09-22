const crypto = require('crypto');
const os = require('os');

/**
 * Optional Supabase control-plane client for the local WhatsApp worker.
 *
 * The worker remains fully functional without Supabase. When SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY are configured, this module registers the worker,
 * publishes status, accepts monitor commands, and maintains monitor leases.
 * The service-role key must only be used by this local worker, never by the
 * Vercel/browser frontend.
 */
function createControlPlane({ workerId, workerName, onCommand, onLeaseExpired }) {
  const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const enabled = Boolean(baseUrl && serviceKey);
  const resolvedWorkerId = workerId || process.env.CONTROL_PLANE_WORKER_ID || `${os.hostname()}-whatsapp-worker`;
  const pollMs = Math.max(3000, Number(process.env.CONTROL_PLANE_POLL_MS || 5000));
  const leaseMs = Math.max(30000, Number(process.env.MONITOR_LEASE_MS || 45000));

  let pollTimer = null;
  let leaseTimer = null;
  let polling = false;
  let currentSession = null;

  async function request(table, options = {}) {
    if (!enabled) return null;
    const response = await fetch(`${baseUrl}/rest/v1/${table}`, {
      ...options,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase ${table} ${response.status}: ${body.slice(0, 300)}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  const displayName = workerName || process.env.CONTROL_PLANE_WORKER_NAME || os.hostname();

  async function registerWorker(status = 'online', metadata = {}) {
    if (!enabled) return null;
    const rows = await request('worker_instances', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        id: resolvedWorkerId,
        status,
        display_name: displayName,
        metadata: { hostname: os.hostname(), platform: process.platform, ...metadata },
        last_seen_at: new Date().toISOString()
      })
    });
    return rows?.[0] || null;
  }

  async function patchWorker(fields) {
    if (!enabled) return;
    try {
      await request(`worker_instances?id=eq.${encodeURIComponent(resolvedWorkerId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...fields, last_seen_at: new Date().toISOString() })
      });
    } catch (err) {
      console.error('[ControlPlane] Worker patch failed:', err.message);
    }
  }

  // Publish the current WhatsApp QR so the shared dashboard can display it.
  async function publishQr(qrData) {
    await patchWorker({ qr_data: qrData, qr_updated_at: new Date().toISOString(), wa_connected: false });
  }

  async function clearQr() {
    await patchWorker({ qr_data: null });
  }

  // Publish WhatsApp connection state (connected/disconnected + number).
  async function updateWaConnection(connected, number) {
    await patchWorker({ wa_connected: !!connected, wa_number: number || null, qr_data: connected ? null : undefined });
  }

  // Append a live event (log line, message sent/failed, sheet check result).
  async function logEvent(eventType, payload = {}, sessionId = null) {
    if (!enabled) return;
    try {
      await request('worker_events', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          worker_id: resolvedWorkerId,
          session_id: sessionId,
          event_type: eventType,
          payload
        })
      });
    } catch (err) {
      console.error('[ControlPlane] Event log failed:', err.message);
    }
  }

  // Insert a message-history row (central reporting across all workers).
  async function recordHistory(entry) {
    if (!enabled) return;
    try {
      await request('message_history', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          worker_id: resolvedWorkerId,
          timestamp: new Date().toISOString(),
          sender: entry.sender || null,
          name: entry.name || null,
          phone: entry.phone || null,
          status: entry.status || null,
          source: entry.source || null,
          error: entry.error || null
        })
      });
    } catch (err) {
      console.error('[ControlPlane] History insert failed:', err.message);
    }
  }

  async function publishStatus(status, metadata = {}) {
    if (!enabled) return;
    try {
      await registerWorker(status, metadata);
    } catch (err) {
      console.error('[ControlPlane] Status update failed:', err.message);
    }
  }

  async function createSession({ ownerId = 'local', config = {} } = {}) {
    if (!enabled) {
      return {
        sessionId: crypto.randomUUID(),
        leaseToken: crypto.randomBytes(24).toString('hex'),
        ownerId
      };
    }
    const session = {
      id: crypto.randomUUID(),
      worker_id: resolvedWorkerId,
      owner_id: ownerId,
      lease_token: crypto.randomBytes(24).toString('hex'),
      state: 'running',
      config,
      last_client_seen_at: new Date().toISOString(),
      started_at: new Date().toISOString()
    };
    const rows = await request('monitor_sessions', {
      method: 'POST',
      body: JSON.stringify(session)
    });
    currentSession = { ...session, ...(rows?.[0] || {}) };
    return {
      sessionId: currentSession.id,
      leaseToken: currentSession.lease_token,
      ownerId: currentSession.owner_id
    };
  }

  async function heartbeat(sessionId, leaseToken) {
    if (!sessionId || !leaseToken) return false;
    if (!enabled) {
      if (!currentSession || currentSession.id !== sessionId || currentSession.lease_token !== leaseToken) return false;
      currentSession.last_client_seen_at = new Date().toISOString();
      return true;
    }
    const rows = await request(`monitor_sessions?id=eq.${encodeURIComponent(sessionId)}&lease_token=eq.${encodeURIComponent(leaseToken)}&state=eq.running`, {
      method: 'PATCH',
      body: JSON.stringify({ last_client_seen_at: new Date().toISOString() })
    });
    return Boolean(rows?.length);
  }

  async function stopSession(sessionId, leaseToken, reason = 'manual') {
    if (!sessionId) return false;
    if (!enabled) {
      if (currentSession?.id !== sessionId || (leaseToken && currentSession.lease_token !== leaseToken)) return false;
      currentSession.state = 'stopped';
      currentSession.stopped_at = new Date().toISOString();
      currentSession.stop_reason = reason;
      return true;
    }
    const filter = `id=eq.${encodeURIComponent(sessionId)}${leaseToken ? `&lease_token=eq.${encodeURIComponent(leaseToken)}` : ''}`;
    const rows = await request(`monitor_sessions?${filter}&state=eq.running`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'stopped', stopped_at: new Date().toISOString(), stop_reason: reason })
    });
    if (rows?.length && currentSession?.id === sessionId) currentSession = null;
    return Boolean(rows?.length);
  }

  async function updateSessionState(state, metadata = {}) {
    if (!enabled || !currentSession) return;
    try {
      await request(`monitor_sessions?id=eq.${encodeURIComponent(currentSession.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ state, metadata, updated_at: new Date().toISOString() })
      });
    } catch (err) {
      console.error('[ControlPlane] Session update failed:', err.message);
    }
  }

  async function pollCommands() {
    if (!enabled || polling) return;
    polling = true;
    try {
      const commands = await request(`monitor_commands?worker_id=eq.${encodeURIComponent(resolvedWorkerId)}&status=eq.pending&order=created_at.asc&limit=10`, { method: 'GET' });
      for (const command of commands || []) {
        const claimed = await request(`monitor_commands?id=eq.${encodeURIComponent(command.id)}&status=eq.pending`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'processing', processed_at: new Date().toISOString() })
        });
        if (!claimed?.length) continue;
        try {
          await onCommand?.(command);
          await request(`monitor_commands?id=eq.${encodeURIComponent(command.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() })
          });
        } catch (err) {
          await request(`monitor_commands?id=eq.${encodeURIComponent(command.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: err.message, completed_at: new Date().toISOString() })
          });
          console.error('[ControlPlane] Command failed:', err.message);
        }
      }
    } catch (err) {
      console.error('[ControlPlane] Command poll failed:', err.message);
    } finally {
      polling = false;
    }
  }

  async function checkLease() {
    if (!currentSession || currentSession.state !== 'running') return;
    if (!enabled) return;
    try {
      const rows = await request(`monitor_sessions?id=eq.${encodeURIComponent(currentSession.id)}&state=eq.running&select=last_client_seen_at`, { method: 'GET' });
      const lastSeen = rows?.[0]?.last_client_seen_at;
      if (lastSeen && Date.now() - new Date(lastSeen).getTime() > leaseMs) {
        const sessionId = currentSession.id;
        currentSession = null;
        await onLeaseExpired?.(sessionId);
      }
    } catch (err) {
      console.error('[ControlPlane] Lease check failed:', err.message);
    }
  }

  // Keep last_seen_at fresh so the dashboard reliably shows this worker online.
  async function heartbeatWorker() {
    await patchWorker({ status: 'online' });
  }

  let heartbeatTimer = null;

  function start() {
    if (!enabled || pollTimer) return;
    registerWorker().catch(err => console.error('[ControlPlane] Registration failed:', err.message));
    pollTimer = setInterval(pollCommands, pollMs);
    leaseTimer = setInterval(checkLease, Math.min(pollMs, 10000));
    // Heartbeat every ~15s (dashboard treats <30s as online).
    heartbeatTimer = setInterval(() => { heartbeatWorker().catch(() => {}); }, 15000);
    pollCommands();
  }

  async function stop() {
    if (pollTimer) clearInterval(pollTimer);
    if (leaseTimer) clearInterval(leaseTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    pollTimer = null;
    leaseTimer = null;
    heartbeatTimer = null;
    if (enabled) await publishStatus('offline');
  }

  return {
    enabled,
    workerId: resolvedWorkerId,
    displayName,
    leaseMs,
    start,
    stop,
    registerWorker,
    publishStatus,
    createSession,
    heartbeat,
    stopSession,
    updateSessionState,
    publishQr,
    clearQr,
    updateWaConnection,
    logEvent,
    recordHistory
  };
}

module.exports = { createControlPlane };
