import { useState } from 'react';
import { Eye, X, Code, Type } from 'lucide-react';
import clsx from 'clsx';

// Sample values used to render a preview of any template. Names + values were
// chosen to be clearly fake (not a real customer) so the admin can spot if a
// template accidentally hard-codes values instead of using {{placeholders}}.
const SAMPLE_VALUES = {
  customer_name:  'Sarah Chen',
  agent_name:     'Priya Sharma',
  domain:         'acme-corp.com',
  gw_edition:     'Business Standard',
  current_plan:   'Moderate',
  plan_name:      'Premium',
  ticket_id:      '#1247',
  // Aliases used by Email Templates' built-in variables
  ticketId:       '1247',
  customerName:   'Sarah Chen',
  agentName:      'Priya Sharma',
  subject:        'DNS verification failing for acme-corp.com',
};

function substitute(text, extraValues = {}) {
  if (!text) return '';
  const values = { ...SAMPLE_VALUES, ...extraValues };
  return text.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    // Leave unknown placeholders visible so admin sees they're not substituting.
    return match;
  });
}

// Detect placeholders that don't have a sample value — admin needs to know
// which ones will appear literally in the customer's view.
function findUnknownPlaceholders(text, extraValues = {}) {
  if (!text) return [];
  const values = { ...SAMPLE_VALUES, ...extraValues };
  const known = new Set();
  const unknown = new Set();
  const re = /\{\{(\w+)\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (Object.prototype.hasOwnProperty.call(values, m[1])) known.add(m[1]);
    else unknown.add(m[1]);
  }
  return { known: [...known], unknown: [...unknown] };
}

export default function TemplatePreviewModal({
  title,            // "Edit preview · GW — Domain verification"
  subject,          // optional — for ticket / email templates
  body,             // the main template body (required)
  meta,             // optional [{label, value}, ...] — small chips above (request type, category, shortcut)
  extraValues = {}, // override or add to SAMPLE_VALUES (e.g. email templates' allowed_variables real samples)
  onClose,
}) {
  const [view, setView] = useState('rendered'); // 'rendered' | 'raw'

  const renderedSubject = substitute(subject, extraValues);
  const renderedBody    = substitute(body, extraValues);
  const subjectInfo     = subject ? findUnknownPlaceholders(subject, extraValues) : { known: [], unknown: [] };
  const bodyInfo        = findUnknownPlaceholders(body, extraValues);
  const allKnown = [...new Set([...subjectInfo.known, ...bodyInfo.known])];
  const allUnknown = [...new Set([...subjectInfo.unknown, ...bodyInfo.unknown])];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Eye className="w-5 h-5 text-blue-600 flex-shrink-0" />
            <h2 className="text-lg font-bold text-gray-800 truncate">{title || 'Preview'}</h2>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap flex-shrink-0">
          {meta?.map(m => (
            <span key={m.label} className="text-[11px] bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full font-medium">
              <strong className="text-gray-500 font-semibold">{m.label}:</strong> {m.value}
            </span>
          ))}
          <div className="ml-auto inline-flex rounded-lg border border-gray-200 overflow-hidden">
            <button
              onClick={() => setView('rendered')}
              className={clsx('px-2.5 py-1 text-xs font-medium inline-flex items-center gap-1',
                view === 'rendered' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50')}
            >
              <Type className="w-3 h-3" /> Rendered
            </button>
            <button
              onClick={() => setView('raw')}
              className={clsx('px-2.5 py-1 text-xs font-medium inline-flex items-center gap-1',
                view === 'raw' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50')}
            >
              <Code className="w-3 h-3" /> Raw
            </button>
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          {subject && (
            <div className="mb-4">
              <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400 mb-1">Subject</p>
              <p className="text-sm font-semibold text-gray-800 break-words">
                {view === 'rendered' ? renderedSubject : subject}
              </p>
            </div>
          )}
          <div>
            <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400 mb-1">Body</p>
            <div className={clsx(
              'rounded-lg border whitespace-pre-wrap break-words text-sm',
              view === 'rendered'
                ? 'bg-gray-50 border-gray-200 text-gray-800 p-3'
                : 'bg-gray-900 border-gray-700 text-gray-100 p-3 font-mono text-xs'
            )}>
              {view === 'rendered' ? renderedBody : body}
            </div>
          </div>

          {(allKnown.length > 0 || allUnknown.length > 0) && (
            <div className="mt-4 pt-3 border-t border-gray-100 space-y-2">
              {allKnown.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400 mb-1">Sample values used</p>
                  <div className="flex flex-wrap gap-1.5">
                    {allKnown.map(k => (
                      <span key={k} className="text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded font-mono">
                        {`{{${k}}}`} → <strong>{(extraValues[k] ?? SAMPLE_VALUES[k]) || ''}</strong>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {allUnknown.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider font-bold text-amber-700 mb-1">⚠ Unknown placeholders (will appear literally in the message)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {allUnknown.map(u => (
                      <span key={u} className="text-[11px] bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded font-mono">
                        {`{{${u}}}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex justify-end flex-shrink-0">
          <button onClick={onClose} className="btn-secondary">Close</button>
        </div>
      </div>
    </div>
  );
}
