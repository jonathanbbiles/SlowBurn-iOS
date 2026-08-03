#!/usr/bin/env bash
#
# asc-submit.sh — submit this app's current App Store version for review.
#
# RUNS INSIDE CODEMAGIC, NEVER LOCALLY. It authenticates with the App Store Connect
# API key that `integrations: app_store_connect:` exports into the build as
#   APP_STORE_CONNECT_KEY_IDENTIFIER / _ISSUER_ID / _PRIVATE_KEY
# Running it on a laptop is both unnecessary and the thing that produced the
# OpenSSL "invalid curve name" error when fastlane parsed the EC key locally.
#
# WHAT IT DOES
#   app-store-connect review-submissions create  <ASC_APP_ID>   -> a review submission
#   app-store-connect review-submissions confirm <SUBMISSION_ID> -> hands it to App Review
# This is the "straight version submit": the listing, screenshots and What's New must
# already be correct in App Store Connect. It uploads no metadata (see the fastlane
# deliver lane for the case where the listing itself needs pushing).
#
# TWO GATES, BOTH MUST PASS
#   1. SUBMIT_FOR_REVIEW must equal "true". This is deliberately NOT set in
#      codemagic.yaml — it is supplied per build by the Codemagic REST API
#      (scripts/cm-build.sh --submit). So a push, or an ordinary build, can never
#      submit anything: the variable simply isn't there.
#   2. ASC_APP_ID must be set (the numeric Apple ID of the app).
#
# Secrets are referenced by NAME only and never echoed — build logs are not private.

set -euo pipefail

say() { printf '    %s\n' "$*"; }
hr()  { printf '== %s\n' "$*"; }

hr "App Store review submission"

# --- Gate 1: explicit, per-build opt-in ---------------------------------------
if [ "${SUBMIT_FOR_REVIEW:-false}" != "true" ]; then
  say "SUBMIT_FOR_REVIEW is not \"true\" — this build stops at TestFlight."
  say "That is the normal path. To submit, start a build with:"
  say "    scripts/cm-build.sh --submit --watch"
  exit 0
fi

# --- Gate 2: which app ---------------------------------------------------------
if [ -z "${ASC_APP_ID:-}" ]; then
  say "ASC_APP_ID is not set — refusing to guess which app to submit."
  say "Set it in the workflow's environment.vars (it is an identifier, not a secret)."
  exit 1
fi

# --- Gate 3: credentials present (names only, never values) --------------------
missing=0
for v in APP_STORE_CONNECT_KEY_IDENTIFIER APP_STORE_CONNECT_ISSUER_ID APP_STORE_CONNECT_PRIVATE_KEY; do
  if [ -z "${!v:-}" ]; then say "MISSING: $v"; missing=1; else say "present: $v"; fi
done
if [ "$missing" -ne 0 ]; then
  say ""
  say "Those come from 'integrations: app_store_connect: ChordLoopAPIKey' in codemagic.yaml."
  say "If they are missing, add the SAME key as three Secure env vars on this app in the"
  say "Codemagic UI (Jonathan does this — they are secret). Never hardcode a key here."
  exit 1
fi

say "submitting app $ASC_APP_ID (platform IOS)"

# --- Create the review submission ---------------------------------------------
hr "review-submissions create"
create_out=""
create_rc=0
create_out="$(app-store-connect review-submissions create --platform IOS --json "$ASC_APP_ID" 2>&1)" || create_rc=$?

if [ "$create_rc" -ne 0 ]; then
  printf '%s\n' "$create_out"
  say ""
  say "Could not create a review submission. The usual causes, in order:"
  say "  - There is already an open submission for this app. Cancel it first:"
  say "        app-store-connect apps cancel-review-submissions $ASC_APP_ID"
  say "  - No App Store version is in 'Prepare for Submission'. Create the version"
  say "    record first (a released app needs a NEW version before it can be submitted)."
  say "  - The version has no build attached yet, or the build is still processing."
  exit 1
fi

printf '%s\n' "$create_out"

SUBMISSION_ID="$(CM_JSON="$create_out" python3 - <<'PY'
import json, os, sys
raw = os.environ["CM_JSON"].strip()
start = raw.find("{")
if start == -1:
    sys.exit("asc-submit: no JSON object in `review-submissions create` output")
try:
    d = json.loads(raw[start:])
except json.JSONDecodeError as e:
    sys.exit("asc-submit: could not parse `review-submissions create` output: %s" % e)
if isinstance(d, list):
    d = d[0] if d else {}
sid = d.get("id") or (d.get("data") or {}).get("id")
if not sid:
    sys.exit("asc-submit: no review submission id in the response: " + json.dumps(d)[:300])
print(sid)
PY
)"

say "review submission id: $SUBMISSION_ID"

# --- Confirm it — THIS is the act of submitting --------------------------------
hr "review-submissions confirm"
if ! app-store-connect review-submissions confirm --json "$SUBMISSION_ID"; then
  say ""
  say "The submission was CREATED but NOT confirmed, so it is sitting in App Store"
  say "Connect unsubmitted. Either confirm it directly:"
  say "    app-store-connect review-submissions confirm $SUBMISSION_ID"
  say "or cancel it:"
  say "    app-store-connect apps cancel-review-submissions $ASC_APP_ID"
  exit 1
fi

hr "SUBMITTED for App Store review — app $ASC_APP_ID, submission $SUBMISSION_ID"
say "Apple review is typically 24-48h. No browser was involved."
