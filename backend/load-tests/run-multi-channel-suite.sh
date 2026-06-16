#!/usr/bin/env bash
# Multi-channel load suite orchestrator.
#
# Requires backend (port 5000) running. Frontend NOT required unless you
# enable the agent-panel spec (it drives a Playwright browser).
#
# Usage (from Git Bash on Windows or any POSIX shell):
#   bash backend/load-tests/run-multi-channel-suite.sh
#
# Env tuning:
#   SCALE          (1)   - multiplier on customers-per-plan (1 = 25 per plan)
#   SKIP_AGENT_UI  (0)   - set to 1 to skip the agent-panel spec (no browser)
#   API_BASE_URL         - default http://localhost:5000
#   UI_BASE_URL          - default http://localhost:5173 (only used by agent UI)

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESULTS="$ROOT/load-results"
mkdir -p "$RESULTS"

# Keep results from prior suite runs but clear OUR files so the analyzer
# only sees the freshest run.
rm -f "$RESULTS"/multi-channel-mixed.jsonl
rm -f "$RESULTS"/mc-channel-comparison.jsonl
rm -f "$RESULTS"/mc-plan-gating.jsonl
rm -f "$RESULTS"/mc-agent-stress.jsonl

echo "─── Preflight ──────────────────────────────────────────────"
echo "  ROOT          : $ROOT"
echo "  RESULTS       : $RESULTS"
echo "  SCALE         : ${SCALE:-1}"
echo "  SKIP_AGENT_UI : ${SKIP_AGENT_UI:-0}"
echo "  API_BASE_URL  : ${API_BASE_URL:-http://localhost:5000}"
echo ""

if ! curl -fsS "${API_BASE_URL:-http://localhost:5000}/api/health" >/dev/null; then
  echo "Backend not reachable — start nodemon first."; exit 2
fi

cd "$ROOT/backend"

echo "─── Seeding mixed-plan test data ───────────────────────────"
SCALE="${SCALE:-1}" node "$ROOT/backend/load-tests/seed-mixed-plans.js" || { echo "Seed failed."; exit 3; }

# Cleanup hook: even if a spec dies hard, drop the seeded rows.
cleanup() {
  echo ""
  echo "─── Cleaning up seeded test data ───────────────────────────"
  node "$ROOT/backend/load-tests/seed-mixed-plans.js" --cleanup || true
}
trap cleanup EXIT

echo ""
echo "─── Channel baseline (one channel at a time) ───────────────"
npx playwright test --config "$ROOT/backend/playwright-load.config.js" \
  "$ROOT/backend/load-tests/channel-comparison.spec.js" \
  --reporter=list || echo "(channel-comparison finished with non-zero — see results)"

echo ""
echo "─── Multi-channel mixed load ──────────────────────────────"
npx playwright test --config "$ROOT/backend/playwright-load.config.js" \
  "$ROOT/backend/load-tests/multi-channel-load.spec.js" \
  --reporter=list || echo "(multi-channel mixed finished with non-zero — see results)"

echo ""
echo "─── Plan-gating correctness ────────────────────────────────"
npx playwright test --config "$ROOT/backend/playwright-load.config.js" \
  "$ROOT/backend/load-tests/plan-gating-load.spec.js" \
  --reporter=list || echo "(plan-gating finished with non-zero — see results)"

if [ "${SKIP_AGENT_UI:-0}" != "1" ]; then
  if curl -fsS "${UI_BASE_URL:-http://localhost:5173}/" >/dev/null 2>&1; then
    echo ""
    echo "─── Agent panel under mixed queue depth ──────────────────"
    npx playwright test --config "$ROOT/backend/playwright-load.config.js" \
      "$ROOT/backend/load-tests/agent-multi-channel-stress.spec.js" \
      --reporter=list || echo "(agent panel finished with non-zero — see results)"
  else
    echo "Vite not reachable at ${UI_BASE_URL:-http://localhost:5173} — skipping agent UI spec"
  fi
fi

echo ""
echo "─── Analyser ──────────────────────────────────────────────"
node "$ROOT/backend/load-tests/analyze-multi-channel-results.js"

echo ""
echo "Done. Raw JSONL is under $RESULTS/"
