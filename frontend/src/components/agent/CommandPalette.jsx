import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Ticket, MessageSquare, User, BarChart2, LayoutDashboard, Hash, X } from 'lucide-react';
import { getAgentTickets, searchCustomers } from '../../services/api';
import clsx from 'clsx';

const PAGES = [
  { type: 'page', label: 'Dashboard',   path: '/agent',             icon: LayoutDashboard },
  { type: 'page', label: 'Tickets',     path: '/agent/tickets',     icon: Ticket },
  { type: 'page', label: 'Chats',       path: '/agent/chats',       icon: MessageSquare },
  { type: 'page', label: 'Performance', path: '/agent/performance', icon: BarChart2 },
];

export default function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tickets, setTickets] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  // Open with Cmd+K / Ctrl+K, close with Escape
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(v => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setTickets([]);
      setCustomers([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Search tickets (by id or subject) + customers
  useEffect(() => {
    if (!open) return;
    clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setTickets([]);
      setCustomers([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      // If query is purely numeric, treat as ticket ID search
      const numeric = /^\d+$/.test(query.trim());
      try {
        const [tRes, cRes] = await Promise.all([
          getAgentTickets({ view: 'all' }).catch(() => ({ data: { tickets: [] } })),
          searchCustomers(query.trim()).catch(() => ({ data: { customers: [] } })),
        ]);
        const allTickets = tRes.data.tickets || [];
        const q = query.toLowerCase();
        const matchedTickets = (numeric
          ? allTickets.filter(t => String(t.id).includes(query.trim()))
          : allTickets.filter(t =>
              t.subject?.toLowerCase().includes(q) ||
              t.customer_name?.toLowerCase().includes(q) ||
              String(t.id).includes(query.trim())
            )
        ).slice(0, 6);
        setTickets(matchedTickets);
        setCustomers((cRes.data.customers || []).slice(0, 5));
        setActiveIdx(0);
      } catch {}
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open]);

  // Build flat results list for keyboard nav
  const filteredPages = !query.trim()
    ? PAGES
    : PAGES.filter(p => p.label.toLowerCase().includes(query.toLowerCase()));
  const results = [
    ...filteredPages.map(p => ({ ...p, key: `p-${p.path}` })),
    ...tickets.map(t => ({
      type: 'ticket', key: `t-${t.id}`, ticket: t,
      label: `#${t.id} ${t.subject}`,
      sub: t.customer_name,
    })),
    ...customers.map(c => ({
      type: 'customer', key: `c-${c.id}`, customer: c,
      label: c.name,
      sub: c.email || c.domain,
    })),
  ];

  const navigateTo = useCallback((r) => {
    if (r.type === 'page') navigate(r.path);
    else if (r.type === 'ticket') {
      // Tickets page selects by URL state; just navigate
      navigate('/agent/tickets');
      // Best-effort: store the ticket id to auto-select if Tickets.jsx reads it
      try { sessionStorage.setItem('cmdk_open_ticket', String(r.ticket.id)); } catch {}
    } else if (r.type === 'customer') {
      navigate('/agent/tickets');
      try { sessionStorage.setItem('cmdk_filter_customer', r.customer.name); } catch {}
    }
    setOpen(false);
  }, [navigate]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) navigateTo(r);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 z-[100] flex items-start justify-center pt-24 px-4">
      {/* Backdrop is decorative only — close via the X button (top-right) or
          Escape key. Same pattern applied across the app's modals so a stray
          click outside doesn't lose state. */}
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden border border-gray-200">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to ticket #, customer, page…"
            className="flex-1 text-sm outline-none bg-transparent"
          />
          <kbd className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">ESC</kbd>
          <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {results.length === 0 && (
            <div className="text-center text-sm text-gray-400 py-10">
              {query ? 'No matches' : 'Start typing to search'}
            </div>
          )}
          {filteredPages.length > 0 && (
            <div className="py-1">
              <p className="px-4 py-1.5 text-[10px] uppercase tracking-wider font-bold text-gray-400">Pages</p>
              {filteredPages.map((p, i) => {
                const idx = i;
                const isActive = activeIdx === idx;
                return (
                  <button
                    key={p.path}
                    onClick={() => navigateTo({ ...p, key: `p-${p.path}` })}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={clsx('w-full text-left px-4 py-2 flex items-center gap-3 text-sm', isActive ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50')}
                  >
                    <p.icon className="w-4 h-4 flex-shrink-0" />
                    <span>{p.label}</span>
                  </button>
                );
              })}
            </div>
          )}
          {tickets.length > 0 && (
            <div className="py-1 border-t border-gray-100">
              <p className="px-4 py-1.5 text-[10px] uppercase tracking-wider font-bold text-gray-400">Tickets</p>
              {tickets.map((t, i) => {
                const idx = filteredPages.length + i;
                const isActive = activeIdx === idx;
                return (
                  <button
                    key={t.id}
                    onClick={() => navigateTo({ type: 'ticket', ticket: t })}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={clsx('w-full text-left px-4 py-2 flex items-center gap-3 text-sm', isActive ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50')}
                  >
                    <Hash className="w-4 h-4 flex-shrink-0 text-gray-400" />
                    <div className="flex-1 min-w-0">
                      <p className="truncate">#{t.id} {t.subject}</p>
                      <p className="text-xs text-gray-400 truncate">{t.customer_name} · {t.status}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {customers.length > 0 && (
            <div className="py-1 border-t border-gray-100">
              <p className="px-4 py-1.5 text-[10px] uppercase tracking-wider font-bold text-gray-400">Customers</p>
              {customers.map((c, i) => {
                const idx = filteredPages.length + tickets.length + i;
                const isActive = activeIdx === idx;
                return (
                  <button
                    key={c.id}
                    onClick={() => navigateTo({ type: 'customer', customer: c })}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={clsx('w-full text-left px-4 py-2 flex items-center gap-3 text-sm', isActive ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50')}
                  >
                    <User className="w-4 h-4 flex-shrink-0 text-gray-400" />
                    <div className="flex-1 min-w-0">
                      <p className="truncate">{c.name}</p>
                      <p className="text-xs text-gray-400 truncate">{c.email} · {c.domain}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between text-[10px] text-gray-400">
          <div className="flex items-center gap-3">
            <span><kbd className="bg-white border border-gray-200 rounded px-1 py-0.5">↑↓</kbd> navigate</span>
            <span><kbd className="bg-white border border-gray-200 rounded px-1 py-0.5">↵</kbd> open</span>
          </div>
          <span><kbd className="bg-white border border-gray-200 rounded px-1 py-0.5">⌘K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
