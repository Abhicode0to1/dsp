// Minimal, dependency-free markdown renderer.
// Handles: **bold**, *italic*, `code`, and auto-linked http(s) URLs.
// Returns an array of React nodes safe to render — never injects raw HTML,
// so XSS is not a risk even when the input came from an end user.
//
// Why not react-markdown?  This codebase wants to stay lean. The patterns we
// actually need (templates I seeded + casual chat formatting) are small.

import React from 'react';

// Order matters: bold (**) BEFORE italic (*) so the asterisks don't get eaten by italic.
// `code` last so nothing inside backticks gets re-processed.
// URLs run as a separate final pass so they appear inside any non-matched plain text.
const STAGES = [
  {
    regex: /\*\*([^*\n]+?)\*\*/g,
    render: (key, text) => <strong key={key} className="font-semibold">{text}</strong>,
  },
  {
    // (?<!\*) — avoid matching the inner asterisks of **bold** (which were already replaced
    // with a React node, so this is mostly belt-and-braces).
    // [^*\n] — italic body can't span newlines or contain its own asterisk.
    regex: /(?<![*\w])\*([^*\n]+?)\*(?!\w)/g,
    render: (key, text) => <em key={key} className="italic">{text}</em>,
  },
  {
    regex: /`([^`\n]+?)`/g,
    render: (key, text) => (
      <code
        key={key}
        className="px-1 py-0.5 bg-gray-200/70 text-gray-800 rounded text-[0.9em] font-mono"
      >
        {text}
      </code>
    ),
  },
  {
    // Auto-link plain URLs. Stops at whitespace and common trailing punctuation.
    regex: /(https?:\/\/[^\s<>"')\]]+)/g,
    render: (key, url) => (
      <a
        key={key}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-blue-600"
      >
        {url}
      </a>
    ),
  },
];

/**
 * Convert a markdown-lite string into React nodes.
 * Wrap the output in something with `whitespace-pre-wrap` to preserve newlines.
 */
export function renderMarkdown(text) {
  if (text === null || text === undefined) return null;
  if (typeof text !== 'string') return text;
  if (text.length === 0) return text;

  // Each pass walks the current array of nodes. For every plain-text node it splits
  // on the pattern; matched chunks become React elements, the rest stays as text.
  let nodes = [text];
  for (const { regex, render } of STAGES) {
    const next = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (typeof node !== 'string') { next.push(node); continue; }
      let lastIndex = 0;
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(node)) !== null) {
        if (m.index > lastIndex) next.push(node.slice(lastIndex, m.index));
        next.push(render(`${i}-${m.index}`, m[1]));
        lastIndex = m.index + m[0].length;
      }
      if (lastIndex < node.length) next.push(node.slice(lastIndex));
    }
    nodes = next;
  }
  return nodes;
}
