#!/usr/bin/env bash
# ============================================================================
# entrypoint.sh — CodeWhale sandbox entrypoint
# ============================================================================
# Reads the audit prompt from stdin or AUDIT_PROMPT env var and runs
# codewhale in headless mode with restricted tool access.
#
# Output is JSON written to stdout. The K8s orchestrator reads this via
# pod logs.
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MODEL="${CODEWHALE_MODEL:-deepseek-v4-flash}"
ALLOWED_TOOLS="${CODEWHALE_ALLOWED_TOOLS:-read,grep}"
OUTPUT_FORMAT="${CODEWHALE_OUTPUT_FORMAT:-json}"
TIMEOUT_MS="${CODEWHALE_TIMEOUT_MS:-120000}"

# ---------------------------------------------------------------------------
# Read prompt
# ---------------------------------------------------------------------------
if [ -n "${AUDIT_PROMPT:-}" ]; then
  GOAL="$AUDIT_PROMPT"
elif [ ! -t 0 ]; then
  # Read from stdin (piped)
  GOAL=$(cat)
else
  echo '{"error":"No AUDIT_PROMPT env var and no stdin provided"}' >&2
  exit 1
fi

# Sanity check
if [ -z "$GOAL" ]; then
  echo '{"error":"Empty prompt"}' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Write prompt to a file to avoid argument-length issues
# ---------------------------------------------------------------------------
PROMPT_FILE="/workspace/audit_prompt.txt"
echo "$GOAL" > "$PROMPT_FILE"

# ---------------------------------------------------------------------------
# Run CodeWhale
# ---------------------------------------------------------------------------
# The prompt is passed as --goal. Allowed tools are restricted to read-only
# operations (read, grep). No write, exec, or network access.
codewhale \
  --goal "$(cat "$PROMPT_FILE")" \
  --allowed-tools "$ALLOWED_TOOLS" \
  --model "$MODEL" \
  --output-format "$OUTPUT_FORMAT" \
  --timeout-ms "$TIMEOUT_MS" \
  2>&1

EXIT_CODE=$?

# Cleanup
rm -f "$PROMPT_FILE"

exit $EXIT_CODE
