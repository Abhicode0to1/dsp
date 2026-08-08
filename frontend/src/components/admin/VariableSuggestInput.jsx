import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

// A textarea (or input) wrapper that watches for the "{" character. When the
// user types it, a small dropdown of available variables appears anchored
// just below the caret. Picking one auto-completes the placeholder as
// {{variableName}} so admins never have to remember exact names or worry
// about typos. Up/Down to navigate, Enter or click to insert, Escape closes.
//
// Variables are passed via the `variables` prop as either:
//   - an array of strings: ['customer_name', 'domain']
//   - an array of objects: [{name: 'customer_name', hint: 'Logged-in customer'}]
//
// Set `multiline` for textarea; default is single-line input.
export default function VariableSuggestInput({
  value,
  onChange,
  variables = [],
  multiline = false,
  rows = 6,
  placeholder,
  className,
  disabled,
  required,
  maxLength,
}) {
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [filter, setFilter] = useState('');
  const [anchorPos, setAnchorPos] = useState({ top: 0, left: 0 });

  // Normalise variables to {name, hint} shape so we can render hint text.
  const normalised = variables.map(v => typeof v === 'string' ? { name: v, hint: '' } : v);
  const filtered = normalised.filter(v =>
    v.name.toLowerCase().includes(filter.toLowerCase())
  );

  // Position the popup just below the textarea's bottom edge — accurate caret
  // positioning inside a textarea requires DOM measurement that's costly. The
  // simpler approach is "always under the input" which still gives a great UX
  // and works for any input length.
  const updateAnchor = () => {
    if (!inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    setAnchorPos({ top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX });
  };

  const insertAt = (varName) => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    // Find the trigger `{` (or `{{`) we wrote that opened the popup, and
    // replace from there to caret. We walk back from the caret looking for
    // the most recent run of "{" or filter characters.
    const before = value.slice(0, start);
    const m = before.match(/\{+[A-Za-z0-9_]*$/);
    const removeFrom = m ? start - m[0].length : start;
    const inserted = `{{${varName}}}`;
    const next = value.slice(0, removeFrom) + inserted + value.slice(end);
    onChange(next);
    setOpen(false);
    setFilter('');
    // Restore caret just after the inserted closing braces.
    requestAnimationFrame(() => {
      if (!inputRef.current) return;
      const caret = removeFrom + inserted.length;
      inputRef.current.focus();
      inputRef.current.setSelectionRange(caret, caret);
    });
  };

  // Detect what we should be showing in the popup based on the text just
  // before the caret. If it matches /\{+[A-Za-z0-9_]*$/ we're in a variable
  // context, show + filter the list. Otherwise close.
  const recomputeFromCaret = (el) => {
    if (!el) return;
    const caret = el.selectionStart;
    const before = (el.value || '').slice(0, caret);
    const m = before.match(/\{+([A-Za-z0-9_]*)$/);
    if (m && variables.length) {
      setFilter(m[1] || '');
      setActiveIndex(0);
      setOpen(true);
      updateAnchor();
    } else {
      setOpen(false);
    }
  };

  const handleChange = (e) => {
    onChange(e.target.value);
    recomputeFromCaret(e.target);
  };

  const handleKeyDown = (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      if (filtered[activeIndex]) {
        e.preventDefault();
        insertAt(filtered[activeIndex].name);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  // Close on click outside.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!inputRef.current) return;
      if (inputRef.current.contains(e.target)) return;
      // Don't close if clicking inside the popup itself.
      if (e.target.closest?.('[data-var-suggest-popup]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const Tag = multiline ? 'textarea' : 'input';

  return (
    <>
      <Tag
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={(e) => recomputeFromCaret(e.target)}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        maxLength={maxLength}
        rows={multiline ? rows : undefined}
        className={clsx('input', multiline && 'min-h-32 resize-y font-mono text-sm', className)}
      />
      {open && filtered.length > 0 && (
        <div
          data-var-suggest-popup
          style={{ position: 'absolute', top: anchorPos.top, left: anchorPos.left, zIndex: 9999, minWidth: 240 }}
          className="bg-white rounded-lg border border-gray-200 shadow-lg max-h-60 overflow-y-auto"
        >
          <div className="px-3 py-1.5 text-[10px] uppercase font-bold tracking-wider text-gray-400 border-b border-gray-100">
            Insert variable {filter && <>· filter "{filter}"</>}
          </div>
          {filtered.map((v, i) => (
            <button
              key={v.name}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); insertAt(v.name); }}
              onMouseEnter={() => setActiveIndex(i)}
              className={clsx(
                'w-full text-left px-3 py-2 text-sm flex items-start justify-between gap-3 transition-colors',
                i === activeIndex ? 'bg-blue-50' : 'hover:bg-gray-50'
              )}
            >
              <span className="font-mono text-xs text-blue-700">{`{{${v.name}}}`}</span>
              {v.hint && <span className="text-[11px] text-gray-500 text-right truncate max-w-[60%]">{v.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
