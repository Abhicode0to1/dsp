# DSP Bug-Fix MCP Server

Exposes the admin-approved bug queue from the DSP `feedback_reports` table to Claude Code, so an agent run can autonomously pick up approved bugs and fix them.

## What it does

The server connects to the same MySQL database the backend uses and exposes three stdio tools:

| Tool | Purpose |
|---|---|
| `list_approved_bugs` | Lists reports with `status='approved'` (oldest reviewed first). Returns minimal fields per row — the agent scans the queue. |
| `get_bug_details(id)` | Full payload for one report: description, page URL, browser info, reporter, admin notes (including the original reporter text if admin rewrote it), and attachment URLs. |
| `mark_bug_fixed(id, fix_summary)` | Closes the loop. Sets `status='fixed'` and appends the summary to `admin_notes`. Required — otherwise the bug will be picked up again. |

## Register with Claude Code

```bash
claude mcp add dsp-bugfix node C:/Users/parde/dsp/mcp-server/server.js
```

Or edit `~/.claude.json` manually under `mcpServers`:

```json
{
  "mcpServers": {
    "dsp-bugfix": {
      "command": "node",
      "args": ["C:/Users/parde/dsp/mcp-server/server.js"]
    }
  }
}
```

The server reads DB credentials from `../backend/.env`, so make sure the backend has been started at least once and that file exists.

## The workflow

1. A customer or agent reports a bug via the in-app widget → row inserted with `status='new'`.
2. Admin reviews at `/admin/feedback`, optionally rewrites the description for clarity, and clicks **Mark as Approved**.
3. Claude is run (interactively or via a scheduled agent) with a prompt like *"Fix the approved bugs in the DSP repo"*.
4. Claude calls `list_approved_bugs`, picks the oldest entry, calls `get_bug_details`, reads the code, ships a fix in a commit, then calls `mark_bug_fixed` with the commit SHA.
5. Admin sees the report move to **Fixed** in the UI, with the fix summary appended to admin notes.

## Autonomous mode

To run the fixer without manual prompts, use the `schedule` skill in Claude Code to create a routine that runs every N hours with this prompt:

> Use the `dsp-bugfix` MCP server to list approved bugs in the DSP support panel. If any exist, pick the oldest one, read the description, make the fix in the repo (frontend at C:/Users/parde/dsp/frontend, backend at C:/Users/parde/dsp/backend), commit on a new branch, push, open a PR, and call `mark_bug_fixed` with the PR URL.

Stop conditions are baked in: the list call returns empty when there's nothing approved, and `mark_bug_fixed` is mandatory after each fix so the same bug can't be processed twice.
