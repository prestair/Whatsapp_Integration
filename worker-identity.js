const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Per-computer worker identity for Design 2A.
 *
 * Each machine gets a stable unique worker id and a friendly display name,
 * persisted in <dataDir>/worker.json so it survives restarts. This prevents
 * multiple users' EXEs from colliding on a single shared id.
 *
 * Priority for id:   env CONTROL_PLANE_WORKER_ID  > worker.json > generated
 * Priority for name: env CONTROL_PLANE_WORKER_NAME > worker.json > hostname
 */
function resolveWorkerIdentity(dataDir) {
  const file = path.join(dataDir, 'worker.json');
  let saved = {};
  try {
    if (fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) { saved = {}; }

  const hostSlug = os.hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'device';

  const id =
    process.env.CONTROL_PLANE_WORKER_ID ||
    saved.id ||
    `${hostSlug}-${crypto.randomBytes(3).toString('hex')}`;

  const name =
    process.env.CONTROL_PLANE_WORKER_NAME ||
    saved.name ||
    os.hostname();

  // Persist so the id/name stay stable across restarts.
  if (saved.id !== id || saved.name !== name) {
    try {
      fs.writeFileSync(file, JSON.stringify({ id, name }, null, 2));
    } catch (e) { /* non-fatal: fall back to in-memory identity */ }
  }

  return { id, name, file };
}

module.exports = { resolveWorkerIdentity };
