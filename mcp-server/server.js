#!/usr/bin/env node
// DSP Bug-Fix MCP Server
// ──────────────────────
// Exposes the admin-approved bug-report queue to Claude Code. Claude calls these
// tools at the start of a "fix the approved bugs" session, picks one, fixes the
// code, then calls mark_bug_fixed so the same report isn't picked up again.
//
// Reads DB creds from ../backend/.env (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME).
// No HTTP auth — this is a dev-time stdio tool for a single developer.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'dsp',
  waitForConnections: true,
  connectionLimit: 5,
});

// Public-facing attachment URL builder. The backend serves /uploads statically; if
// the agent is running on the same host, prepend FRONTEND_URL so Claude can fetch
// images for context. Falls back to relative path if env is unset.
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const expandAttachmentUrls = (atts) => {
  const arr = !atts ? [] : Array.isArray(atts) ? atts : (() => { try { return JSON.parse(atts); } catch { return []; } })();
  return arr.map(a => ({ ...a, url: a.path?.startsWith('http') ? a.path : `${FRONTEND_URL.replace(/\/$/, '')}${a.path}` }));
};

const tools = [
  {
    name: 'list_approved_bugs',
    description:
      'List bug reports that an admin has marked APPROVED but Claude has not yet marked FIXED. ' +
      'Returns minimal fields per row (id, title, panel, reporter_role, has_attachments, page_url, created_at) ' +
      'so the agent can scan the queue. Call get_bug_details(id) for the full payload before working on one. ' +
      'Returns an empty array if no work is queued — agent should stop in that case.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max rows to return (default 20).', default: 20 },
      },
    },
  },
  {
    name: 'get_bug_details',
    description:
      'Fetch the full report for one approved bug — title, description, page URL, browser info, reporter, ' +
      'admin notes (which may contain the original reporter text if admin rewrote the description), and ' +
      'attachment URLs the agent can fetch. Call this AFTER list_approved_bugs picks an id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Report ID from list_approved_bugs.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mark_bug_fixed',
    description:
      'Close the loop: set status=fixed on a report once the agent has committed a fix. ' +
      'The fix_summary is appended to admin_notes so the admin can audit what was changed without reading the diff. ' +
      'This is REQUIRED — otherwise the same bug will be returned by list_approved_bugs on the next run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Report ID.' },
        fix_summary: {
          type: 'string',
          description: 'One or two sentences describing the change. Include the commit SHA if available and the files touched.',
        },
      },
      required: ['id', 'fix_summary'],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'list_approved_bugs': {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const [rows] = await pool.query(
        `SELECT f.id, f.title, f.panel, f.reporter_role, f.page_url, f.created_at,
                (f.attachments IS NOT NULL AND JSON_LENGTH(f.attachments) > 0) AS has_attachments,
                u.name AS reporter_name
         FROM feedback_reports f
         JOIN users u ON u.id = f.reporter_user_id
         WHERE f.status = 'approved'
         ORDER BY f.reviewed_at ASC
         LIMIT ?`,
        [limit]
      );
      return { count: rows.length, bugs: rows };
    }

    case 'get_bug_details': {
      const id = Number(args.id);
      if (!id) throw new Error('id is required');
      const [[row]] = await pool.query(
        `SELECT f.*, u.name AS reporter_name, u.email AS reporter_email,
                ru.name AS reviewer_name
         FROM feedback_reports f
         JOIN users u ON u.id = f.reporter_user_id
         LEFT JOIN users ru ON ru.id = f.reviewed_by
         WHERE f.id = ?`,
        [id]
      );
      if (!row) throw new Error(`Bug #${id} not found`);
      return { ...row, attachments: expandAttachmentUrls(row.attachments) };
    }

    case 'mark_bug_fixed': {
      const id = Number(args.id);
      const summary = String(args.fix_summary || '').trim();
      if (!id) throw new Error('id is required');
      if (!summary) throw new Error('fix_summary is required');
      const [[existing]] = await pool.query(
        'SELECT status, admin_notes FROM feedback_reports WHERE id = ?',
        [id]
      );
      if (!existing) throw new Error(`Bug #${id} not found`);
      if (existing.status !== 'approved') {
        throw new Error(`Bug #${id} is in status '${existing.status}', not 'approved'. Refusing to mark fixed.`);
      }
      const stamp = new Date().toISOString();
      const fixLine = `--- AUTO-FIX (${stamp}) ---\n${summary}`;
      const nextNotes = existing.admin_notes ? `${existing.admin_notes}\n\n${fixLine}` : fixLine;
      await pool.query(
        `UPDATE feedback_reports SET status='fixed', admin_notes=?, reviewed_at=NOW() WHERE id = ?`,
        [nextNotes, id]
      );
      return { ok: true, id, status: 'fixed' };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'dsp-bugfix-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const result = await callTool(req.params.name, req.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// eslint-disable-next-line no-console
console.error('[dsp-bugfix-mcp] connected via stdio');
