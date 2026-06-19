// Helpers for the `calls.participants` JSON column — the ordered list of agents
// who handled a call. A call with more than one distinct agent was transferred
// (e.g. Abhishek → Ranjeet). Shared by the customer, agent, and admin call lists
// so they describe a transferred call the same way.

// participants is a JSON array of { agent_id, agent_name, joined_at }. mysql2 may
// hand it back already-parsed (array) or as a JSON string — handle both.
export function parseParticipants(p) {
  if (!p) return [];
  let arr = p;
  if (typeof p === 'string') {
    try { arr = JSON.parse(p); } catch { return []; }
  }
  return Array.isArray(arr) ? arr : [];
}

// Distinct agent names in the order they joined, e.g. ["Abhishek", "Ranjeet"].
export function transferAgents(participants) {
  const seen = new Set();
  const out = [];
  for (const x of parseParticipants(participants)) {
    const n = (x?.agent_name || '').trim();
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// True when the call passed through more than one agent (i.e. was transferred).
export function wasTransferred(participants) {
  return transferAgents(participants).length > 1;
}

// Parse the admin call list's `recordings` JSON (one entry per recording leg of
// the call), oldest-first so a transferred call plays in agent order. Each entry:
// { id, mime, size, uploaded_by, uploader, created_at }.
export function parseRecordings(r) {
  if (!r) return [];
  let arr = r;
  if (typeof r === 'string') {
    try { arr = JSON.parse(r); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.slice().sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
}
