// Cached read of the admin_settings k/v table. Anything that needs to make a
// behavior decision based on an admin setting reads through here so we don't
// hit the DB on every email send, every chat open, every call attempt, etc.
//
// Invalidated automatically when updateSettings writes via
// `invalidateAllSettingsCache()` (called from adminController.updateSettings).
// The TTL backstop covers admin_settings writes from outside the API path
// (e.g. seed scripts) — they propagate within 60 seconds.
const { pool } = require('../config/database');

let cache = null;
let cachedAt = 0;
const TTL_MS = 60 * 1000;

async function refresh() {
  const [rows] = await pool.query('SELECT `key`, value FROM admin_settings');
  cache = Object.fromEntries(rows.map(r => [r.key, r.value]));
  cachedAt = Date.now();
  return cache;
}

async function getAllSettings() {
  if (cache && (Date.now() - cachedAt) < TTL_MS) return cache;
  return refresh();
}

async function getSetting(key, fallback = '') {
  const all = await getAllSettings();
  return all[key] !== undefined ? all[key] : fallback;
}

async function getBoolSetting(key, fallback = false) {
  const v = await getSetting(key, fallback ? '1' : '0');
  return v === '1' || v === 'true' || v === 1 || v === true;
}

async function getIntSetting(key, fallback = 0) {
  const v = await getSetting(key, String(fallback));
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function invalidateAllSettingsCache() {
  cache = null;
}

module.exports = {
  getAllSettings,
  getSetting,
  getBoolSetting,
  getIntSetting,
  invalidateAllSettingsCache,
};
