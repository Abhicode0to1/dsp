// Shared in-memory agent presence tracking. Used by:
//   - chatSocket.js to track online/away/busy/on_break status
//   - assignment.js to filter candidates for routing
// Status is set by socket events; entries are removed on disconnect.
// Exposes Map-compatible methods so existing call sites work unchanged.
const statuses = new Map(); // userId -> 'online' | 'away' | 'busy' | 'on_break'

module.exports = {
  // Map-compatible interface
  set: (id, status) => statuses.set(Number(id), status),
  get: (id) => statuses.get(Number(id)),
  has: (id) => statuses.has(Number(id)),
  delete: (id) => statuses.delete(Number(id)),
  forEach: (fn) => statuses.forEach((v, k) => fn(v, k)),
  get size() { return statuses.size; },

  // Convenience helpers
  setStatus: (id, status) => statuses.set(Number(id), status),
  getStatus: (id) => statuses.get(Number(id)),
  hasStatus: (id) => statuses.has(Number(id)),
  all: () => new Map(statuses),
  countOnline: () => {
    let n = 0;
    statuses.forEach(s => { if (s === 'online') n++; });
    return n;
  },
};
