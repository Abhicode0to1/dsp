#!/usr/bin/env bash
# UI load suite orchestrator.
#
# Assumes Vite (5173) + nodemon (5000) are already running. On Windows, run
# this from Git Bash or WSL. On macOS/Linux, just `bash run-ui-load-suite.sh`.
#
# Tunable env vars (defaults in parens):
#   CUSTOMER_CONC  (20)  # parallel customer browser contexts
#   AGENT_QUEUE    (20)  # # of waiting chats to seed in agent dashboard
#   AGENT_CONC     (1)   # # of concurrent agent contexts
#   HAMMER_N       (20)  # # of customers hammering bot-ticket endpoint in scenario 4
#   API_BASE_URL         # default http://localhost:5000
#   UI_BASE_URL          # default http://localhost:5173

set -u  # don't bail on first error — we want every spec to run
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESULTS="$ROOT/load-results"

mkdir -p "$RESULTS"
# Truncate previous results so the analyzer sees a clean slate.
find "$RESULTS" -maxdepth 1 -name '*.jsonl' -delete 2>/dev/null || true

echo "─── Preflight ──────────────────────────────────────────────"
echo "  ROOT             : $ROOT"
echo "  RESULTS          : $RESULTS"
echo "  CUSTOMER_CONC    : ${CUSTOMER_CONC:-20}"
echo "  AGENT_QUEUE      : ${AGENT_QUEUE:-20}"
echo "  AGENT_CONC       : ${AGENT_CONC:-1}"
echo "  HAMMER_N         : ${HAMMER_N:-20}"
echo "  API_BASE_URL     : ${API_BASE_URL:-http://localhost:5000}"
echo "  UI_BASE_URL      : ${UI_BASE_URL:-http://localhost:5173}"
echo ""

if ! curl -fsS "${API_BASE_URL:-http://localhost:5000}/api/health" >/dev/null; then
  echo "Backend not reachable — start nodemon first."; exit 2
fi
if ! curl -fsS "${UI_BASE_URL:-http://localhost:5173}/" >/dev/null; then
  echo "Vite dev server not reachable — start npm run dev first."; exit 2
fi

cd "$ROOT/backend"

echo ""
echo "─── Customer stress spec ───────────────────────────────────"
npx playwright test --config "$ROOT/backend/playwright-load.config.js" \
  "$ROOT/backend/load-tests/customer-ui-stress.spec.js" \
  --reporter=list || echo "(customer spec finished with non-zero — see results)"

echo ""
echo "─── Agent stress spec ──────────────────────────────────────"
npx playwright test --config "$ROOT/backend/playwright-load.config.js" \
  "$ROOT/backend/load-tests/agent-ui-stress.spec.js" \
  --reporter=list || echo "(agent spec finished with non-zero — see results)"

echo ""
echo "─── Analyser ──────────────────────────────────────────────"
node "$ROOT/backend/load-tests/analyze-ui-results.js"

echo ""
echo "Done. Raw JSONL is under $RESULTS/."
