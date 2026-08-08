import { useEffect, useState } from 'react';
import Layout from '../../components/common/Layout';
import { getAdminAgents, createAdminAgent, toggleAdminAgent, changeAgentPassword, updateAgentSkills, deleteAdminAgent, changeAgentRole } from '../../services/api';
import { UserPlus, CheckCircle, XCircle, Ticket, MessageSquare, RefreshCw, X, KeyRound, Tag, Check, Trash2, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../contexts/AuthContext';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

// Inline editor for an agent's skill tags. Tags are matched against ticket
// request_type during auto-routing. Tags are free-text — admin defines vocabulary.
function SkillTagsEditor({ agent, onUpdated }) {
  const [editing, setEditing] = useState(false);
  const [tags, setTags] = useState(agent.skill_tags || []);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await updateAgentSkills(agent.id, { skill_tags: tags });
      onUpdated(agent.id, r.data.skill_tags);
      setEditing(false);
      toast.success('Skills updated');
    } catch { toast.error('Failed to save skills'); }
    finally { setSaving(false); }
  };

  const addTag = () => {
    const t = input.trim();
    if (!t) return;
    if (tags.includes(t)) { setInput(''); return; }
    setTags([...tags, t]);
    setInput('');
  };

  if (!editing) {
    return (
      <div className="flex flex-wrap gap-1 items-center">
        {(agent.skill_tags || []).map(t => (
          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">{t}</span>
        ))}
        <button onClick={() => { setTags(agent.skill_tags || []); setEditing(true); }} className="text-[10px] text-gray-400 hover:text-blue-600 inline-flex items-center gap-0.5">
          <Tag className="w-2.5 h-2.5" /> {agent.skill_tags?.length ? 'Edit' : '+ Tag'}
        </button>
      </div>
    );
  }

  // Quick-pick palette matches the routing vocabulary used by pickAgent's
  // categoryToTagPriority(). Admin can click these chips to toggle membership;
  // free-form text input still works for ad-hoc tags (skill_tags is a JSON array).
  const ROUTING_TAGS = [
    { key: 'technical',          label: 'Technical',          hint: 'Tech / product issues' },
    { key: 'primary_billing',    label: 'Primary Billing',    hint: 'Lead billing agent' },
    { key: 'secondary_billing',  label: 'Secondary Billing',  hint: 'Backup billing agent' },
    { key: 'other',              label: 'Other',              hint: 'Misc / general queries' },
  ];

  return (
    <div className="border border-blue-200 rounded-lg p-1.5 bg-white space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {tags.map(t => (
          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100 inline-flex items-center gap-1">
            {t}
            <button onClick={() => setTags(tags.filter(x => x !== t))}><X className="w-2.5 h-2.5" /></button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 pt-1 border-t border-blue-100">
        <span className="text-[9px] text-gray-500 font-semibold uppercase tracking-wide w-full mb-0.5">Routing tags (drive customer-category matching)</span>
        {ROUTING_TAGS.map(rt => {
          const active = tags.includes(rt.key);
          return (
            <button
              key={rt.key}
              type="button"
              title={rt.hint}
              onClick={() => setTags(active ? tags.filter(x => x !== rt.key) : [...tags, rt.key])}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'}`}
            >
              {active ? '✓ ' : '+ '}{rt.label}
            </button>
          );
        })}
      </div>
      <div className="flex gap-1">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
          placeholder="ad-hoc tag (e.g. spanish, vip-account)"
          className="input text-[10px] py-0.5 flex-1"
        />
        <button onClick={addTag} className="text-[10px] px-1.5 rounded bg-gray-100 hover:bg-gray-200">Add</button>
        <button onClick={handleSave} disabled={saving} className="text-[10px] px-1.5 rounded bg-blue-600 text-white inline-flex items-center gap-0.5">
          <Check className="w-2.5 h-2.5" /> {saving ? '…' : 'Save'}
        </button>
        <button onClick={() => setEditing(false)} className="text-[10px] px-1.5 rounded bg-gray-100 hover:bg-gray-200">Cancel</button>
      </div>
    </div>
  );
}

function ChangePasswordModal({ agent, onClose }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [saving, setSaving]     = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password.length < 6) { toast.error('Password must be at least 6 characters'); return; }
    if (password !== confirm) { toast.error('Passwords do not match'); return; }
    setSaving(true);
    try {
      await changeAgentPassword(agent.id, { password });
      toast.success(`Password updated for ${agent.name}`);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update password');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">Change Password</h2>
            <p className="text-xs text-gray-400 mt-0.5">{agent.name} — {agent.email}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
            <input
              type="password"
              className="input w-full"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Min 6 characters"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Confirm Password</label>
            <input
              type="password"
              className="input w-full"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="Repeat password"
              required
            />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center">
              {saving ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Update Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreateAgentModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'agent' });
  const [saving, setSaving] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name || !form.email || !form.password) return;
    setSaving(true);
    createAdminAgent(form)
      .then(() => { toast.success(form.role === 'admin' ? 'Admin created' : 'Agent created'); onCreated(); })
      .catch(err => toast.error(err.response?.data?.error || 'Failed to create user'))
      .finally(() => setSaving(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-800">Create New {form.role === 'admin' ? 'Admin' : 'Agent'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
            <select
              className="input w-full"
              value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
            >
              <option value="agent">Agent</option>
              <option value="admin">Admin</option>
            </select>
            {form.role === 'admin' && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded mt-2 px-2.5 py-1.5">
                Admins have full access to customers, agents, plans, billing and settings. Only create one for someone you trust.
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
            <input
              className="input w-full"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="John Doe"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
            <input
              type="email"
              className="input w-full"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder={form.role === 'admin' ? 'admin@company.com' : 'agent@company.com'}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              className="input w-full"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="Min 8 characters"
              required
            />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center">
              {saving ? 'Creating...' : (form.role === 'admin' ? 'Create Admin' : 'Create Agent')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Confirms a role change (agent ↔ admin) before firing the API. Carries enough
// context that the user knows exactly what's about to happen and to whom.
function ChangeRoleModal({ agent, onClose, onChanged }) {
  const [saving, setSaving] = useState(false);
  // Target role comes from the dropdown (passed in as `_newRole`); fall back to
  // a straight toggle for older callers that didn't supply one.
  const newRole = agent._newRole || (agent.role === 'admin' ? 'agent' : 'admin');
  const promoting = newRole === 'admin';

  const submit = async () => {
    setSaving(true);
    try {
      await changeAgentRole(agent.id, newRole);
      toast.success(promoting
        ? `${agent.name} is now an admin`
        : `${agent.name} is now an agent`);
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to change role');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-800">
            {promoting ? 'Promote to Admin' : 'Demote to Agent'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          {promoting ? (
            <>You're about to give <strong>{agent.name}</strong> ({agent.email}) full admin access. They'll be able to manage customers, agents, plans, billing and every other admin setting.</>
          ) : (
            <>You're about to remove admin access from <strong>{agent.name}</strong> ({agent.email}). They'll keep their account but only have regular agent permissions.</>
          )}
        </p>
        <div className={`text-xs rounded px-3 py-2 mb-4 border ${promoting ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-blue-50 border-blue-200 text-blue-800'}`}>
          {promoting
            ? 'Only promote people you trust. Admins can change plans, delete customers, and create more admins.'
            : 'They will need to sign out and back in for the change to fully take effect.'}
        </div>
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className={`flex-1 justify-center text-sm font-medium px-4 py-2 rounded-lg transition-colors ${
              promoting
                ? 'bg-purple-600 text-white hover:bg-purple-700'
                : 'bg-gray-700 text-white hover:bg-gray-800'
            } disabled:opacity-60`}
          >
            {saving ? 'Saving…' : promoting ? 'Yes, make admin' : 'Yes, demote to agent'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminAgents() {
  const { user: currentUser } = useAuth();
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [toggling, setToggling] = useState(null);
  const [changePwAgent, setChangePwAgent] = useState(null);
  const [deleteAgent, setDeleteAgent] = useState(null);
  const [roleAgent, setRoleAgent] = useState(null);

  const load = () => {
    setLoading(true);
    getAdminAgents()
      .then(res => setAgents(res.data.agents || []))
      .catch(() => toast.error('Failed to load agents'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  useGlobalRefresh(load);

  const handleToggle = (id) => {
    setToggling(id);
    toggleAdminAgent(id)
      .then(() => { toast.success('Agent status updated'); load(); })
      .catch(() => toast.error('Failed to update agent'))
      .finally(() => setToggling(null));
  };

  return (
    <Layout>
      {showCreate && (
        <CreateAgentModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
      {changePwAgent && (
        <ChangePasswordModal
          agent={changePwAgent}
          onClose={() => setChangePwAgent(null)}
        />
      )}
      {deleteAgent && (
        <DeleteAgentModal
          agent={deleteAgent}
          onClose={() => setDeleteAgent(null)}
          onDeleted={() => { setDeleteAgent(null); load(); }}
        />
      )}
      {roleAgent && (
        <ChangeRoleModal
          agent={roleAgent}
          onClose={() => setRoleAgent(null)}
          onChanged={() => { setRoleAgent(null); load(); }}
        />
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Agent Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage support agents, create accounts, and monitor performance</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="btn-secondary hidden lg:inline-flex"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
            <UserPlus className="w-4 h-4" />
            New Agent
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px] lg:min-w-0">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-3 font-semibold text-gray-600">Agent</th>
                <th className="text-center px-4 py-3 font-semibold text-gray-600">Open Tickets</th>
                <th className="text-center px-4 py-3 font-semibold text-gray-600">Active Chats</th>
                <th className="text-center px-4 py-3 font-semibold text-gray-600">Resolved Today</th>
                <th className="text-center px-4 py-3 font-semibold text-gray-600">Total Tickets</th>
                <th className="text-center px-4 py-3 font-semibold text-gray-600">Status</th>
                <th className="text-center px-4 py-3 font-semibold text-gray-600">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {agents.length === 0 && (
                <tr><td colSpan="7" className="text-center py-12 text-gray-400">No agents found</td></tr>
              )}
              {agents.map(agent => (
                <tr key={agent.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-sm font-bold text-blue-700 flex-shrink-0">
                        {agent.name[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-800 flex items-center gap-1.5">
                          {agent.name}
                          {agent.role === 'admin' && <span className="text-[9px] uppercase tracking-wider bg-purple-100 text-purple-700 px-1 py-0.5 rounded font-bold">Admin</span>}
                        </p>
                        <p className="text-xs text-gray-400">{agent.email}</p>
                        <div className="mt-1">
                          <SkillTagsEditor
                            agent={agent}
                            onUpdated={(id, newTags) => setAgents(prev => prev.map(a => a.id === id ? { ...a, skill_tags: newTags } : a))}
                          />
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <Ticket className="w-3.5 h-3.5 text-amber-500" />
                      <span className="font-semibold text-gray-800">{agent.open_tickets ?? 0}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <MessageSquare className="w-3.5 h-3.5 text-blue-500" />
                      <span className="font-semibold text-gray-800">{agent.active_chats ?? 0}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="font-semibold text-green-700">{agent.resolved_today ?? 0}</span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="font-semibold text-gray-700">{agent.total_tickets ?? 0}</span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {agent.is_active ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-xs font-medium">
                        <CheckCircle className="w-3 h-3" /> Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-medium">
                        <XCircle className="w-3 h-3" /> Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        disabled={toggling === agent.id}
                        onClick={() => handleToggle(agent.id)}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                          agent.is_active
                            ? 'bg-red-50 text-red-600 hover:bg-red-100'
                            : 'bg-green-50 text-green-600 hover:bg-green-100'
                        }`}
                      >
                        {toggling === agent.id ? '...' : agent.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        onClick={() => setChangePwAgent(agent)}
                        className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg font-medium bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                        title="Change password"
                      >
                        <KeyRound className="w-3.5 h-3.5" /> Password
                      </button>
                      {(() => {
                        const isSelf = agent.id === currentUser?.id;
                        return (
                          <select
                            value={agent.role}
                            disabled={isSelf}
                            onChange={e => {
                              const next = e.target.value;
                              if (next === agent.role) return;
                              // Stash the new role on the agent so the confirm dialog knows
                              // what we're about to switch to. The dialog reads agent.role
                              // for the "from" side; we pass the target through a wrapper.
                              setRoleAgent({ ...agent, _newRole: next });
                            }}
                            className={`text-xs border rounded-lg px-2 py-1.5 focus:outline-none ${
                              isSelf
                                ? 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed'
                                : 'border-gray-200 bg-white hover:border-gray-300 focus:border-blue-400 cursor-pointer'
                            }`}
                            title={isSelf ? "You can't change your own role" : 'Change role'}
                          >
                            <option value="agent">Agent</option>
                            <option value="admin">Admin</option>
                          </select>
                        );
                      })()}
                      <button
                        onClick={() => setDeleteAgent(agent)}
                        className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg font-medium bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                        title="Remove agent permanently"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </Layout>
  );
}

// Two-step delete confirmation. Agent has to type the email to confirm.
// On success, backend nullifies agent_id on tickets/chats/calls but keeps the data,
// so customer history isn't lost when an agent leaves the team.
function DeleteAgentModal({ agent, onClose, onDeleted }) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const canConfirm = confirmText.trim().toLowerCase() === agent.email.toLowerCase();

  const submit = async () => {
    setDeleting(true);
    try {
      const res = await deleteAdminAgent(agent.id);
      const r = res.data.reassigned;
      toast.success(`Agent removed. ${r.tickets} ticket(s), ${r.chats} chat(s), ${r.calls} call(s) preserved with agent set to "unassigned".`, { duration: 6000 });
      onDeleted?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to remove agent');
    } finally {
      setDeleting(false);
    }
  };

  return (
    // Backdrop is decorative only — closes only via X / Cancel button so users
    // don't lose half-typed form data on a stray click outside.
    <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-100 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-red-500" />
          </div>
          <div className="flex-1">
            <h2 className="font-semibold text-gray-800">Remove agent</h2>
            <p className="text-xs text-gray-500 mt-0.5">This permanently deletes the agent account.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
            <p className="font-medium mb-1">{agent.name} &lt;{agent.email}&gt;</p>
            <p className="text-xs">Their assigned tickets, chats, and calls will <strong>remain in the system</strong> but show as <em>unassigned</em>. The agent will lose access immediately.</p>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-700 block mb-1">Type the agent's email to confirm</label>
            <input
              type="text"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder={agent.email}
              autoFocus
              className="input w-full text-sm font-mono"
            />
          </div>
        </div>
        <div className="px-5 py-4 bg-gray-50 rounded-b-2xl flex justify-end gap-2">
          <button onClick={onClose} disabled={deleting} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
          <button
            onClick={submit}
            disabled={!canConfirm || deleting}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-4 h-4" /> {deleting ? 'Removing…' : 'Remove agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
