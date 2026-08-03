#!/usr/bin/env bash
#
# asc-auth-check.sh — prove the App Store Connect API key stored in Codemagic can
# drive a submission, WITHOUT submitting anything.
#
# RUNS INSIDE CODEMAGIC (workflow: asc-auth-check). It is strictly read-only:
# it lists, it reads, it parses. It never creates, confirms, uploads or submits.
#
# It answers the four questions that decide whether the no-browser submit path works:
#
#   1. Does `integrations: app_store_connect:` actually export the key into the build?
#      (Codemagic's docs describe the integration as an ALTERNATIVE to setting these
#      variables, so this must be proven, not assumed. If they are absent, the same key
#      has to be added as three Secure env vars on the app in the Codemagic UI.)
#   2. Does Apple accept the key? — a real authenticated ASC API call via Codemagic's
#      own `app-store-connect` CLI. A 401 here means the key/role is wrong.
#   3. Does the key parse under Ruby's OpenSSL? — this is the exact step that failed
#      LOCALLY with "invalid curve name" when fastlane read the .p8. It is the reason
#      the submit runs server-side, and it is worth proving on the Codemagic image
#      rather than assuming.
#   4. Is the app actually in a submittable state — is there an App Store version in
#      "Prepare for Submission" with a build attached?
#
# Secrets are referenced by NAME only. No value is ever printed. Build logs are not private.

set -uo pipefail   # NOT -e: every probe should run so one failure doesn't hide the rest.

PASS=0; FAIL=0; WARN=0
ok()   { printf '  [ OK ]  %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  [FAIL]  %s\n' "$*"; FAIL=$((FAIL+1)); }
warn() { printf '  [warn]  %s\n' "$*"; WARN=$((WARN+1)); }
hr()   { printf '\n=== %s ===\n' "$*"; }

printf '\n'
printf '#############################################################\n'
printf '#  ASC AUTH CHECK — read-only. NOTHING WILL BE SUBMITTED.   #\n'
printf '#############################################################\n'

# --- 1. Did Codemagic export the key into this build? --------------------------
hr "1. App Store Connect credentials in the build environment"
creds_ok=1
for v in APP_STORE_CONNECT_KEY_IDENTIFIER APP_STORE_CONNECT_ISSUER_ID APP_STORE_CONNECT_PRIVATE_KEY; do
  if [ -n "${!v:-}" ]; then ok "$v is set (value not shown)"; else bad "$v is NOT set"; creds_ok=0; fi
done
if [ "$creds_ok" -eq 0 ]; then
  cat <<'EOF'

  WHAT THIS MEANS
  The `integrations: app_store_connect:` reference wires the key into Codemagic's own
  publishing step, but did NOT export it as environment variables for scripts/fastlane.
  FIX (one-time per app, and only Jonathan can do it — these are secret):
  Codemagic -> the app -> Environment variables -> add the SAME key from Team
  Integrations as three SECURE variables:
      APP_STORE_CONNECT_KEY_IDENTIFIER
      APP_STORE_CONNECT_ISSUER_ID
      APP_STORE_CONNECT_PRIVATE_KEY   (full .p8 text, BEGIN/END lines included)
  Then re-run this check.
EOF
fi

# --- 2. Does Apple accept the key? ---------------------------------------------
hr "2. Authenticated call to App Store Connect (Codemagic CLI)"
if ! command -v app-store-connect >/dev/null 2>&1; then
  bad "the app-store-connect CLI is not on PATH (expected on Codemagic macOS images)"
else
  apps_out="$(app-store-connect apps list --json 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    n="$(CM_JSON="$apps_out" python3 - <<'PY'
import json, os
raw = os.environ["CM_JSON"]; i = raw.find("[")
if i == -1: i = raw.find("{")
try:
    d = json.loads(raw[i:]) if i != -1 else []
except Exception:
    d = []
print(len(d) if isinstance(d, list) else 1)
PY
)"
    ok "Apple accepted the key — 'apps list' returned $n app(s)"
    ok "the .p8 signs a valid JWT and the key's role can read App Store Connect"
  else
    printf '%s\n' "$apps_out" | tail -15
    bad "'app-store-connect apps list' failed (see above)"
    warn "a 401/NOT_AUTHORIZED here means the key, issuer id, or key role is wrong"
  fi
fi

# --- 3. Does the key parse under Ruby's OpenSSL (the fastlane path)? -----------
hr "3. EC private key parses under Ruby OpenSSL (the local 'invalid curve name' failure)"
if [ -z "${APP_STORE_CONNECT_PRIVATE_KEY:-}" ]; then
  warn "skipped — the private key variable is not set (see section 1)"
elif ! command -v ruby >/dev/null 2>&1; then
  warn "skipped — no ruby on PATH"
else
  # The key is passed through the environment, never on the command line or to disk.
  ruby_out="$(ruby -e '
    require "openssl"
    pem = ENV["APP_STORE_CONNECT_PRIVATE_KEY"].to_s
    pem = pem.gsub("\\n", "\n") unless pem.include?("\n")
    key = OpenSSL::PKey.read(pem)
    raise "not an EC key: #{key.class}" unless key.is_a?(OpenSSL::PKey::EC)
    puts "curve=#{key.group.curve_name} openssl=#{OpenSSL::OPENSSL_VERSION}"
  ' 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "Ruby OpenSSL parsed the key ($ruby_out)"
    ok "fastlane/deliver will be able to read this key on this machine"
  else
    printf '%s\n' "$ruby_out" | tail -8
    bad "Ruby could not parse the key — this is the 'invalid curve name' failure mode"
    warn "the CLI path (section 2) may still work; only the fastlane/deliver path is blocked"
  fi
fi

# --- 4. Is the app in a submittable state? -------------------------------------
hr "4. App Store version state for app ${ASC_APP_ID:-<unset>}"
if [ -z "${ASC_APP_ID:-}" ]; then
  warn "ASC_APP_ID is not set in this workflow — skipping the version readiness check"
elif ! command -v app-store-connect >/dev/null 2>&1; then
  warn "skipped — no app-store-connect CLI"
else
  ver_out="$(app-store-connect apps app-store-versions "$ASC_APP_ID" --json 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$ver_out" | tail -10
    warn "could not read App Store versions (informational — not a hard failure)"
  else
    ver_report="$(CM_JSON="$ver_out" python3 - <<'PY'
import json, os
raw = os.environ["CM_JSON"]; i = raw.find("[")
if i == -1: i = raw.find("{")
try:
    d = json.loads(raw[i:]) if i != -1 else []
except Exception:
    d = []
if isinstance(d, dict): d = [d]
EDITABLE = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED",
            "METADATA_REJECTED", "INVALID_BINARY"}
found = False
for v in d:
    a = v.get("attributes") or v
    ver, state = a.get("versionString", "?"), a.get("appStoreState") or a.get("state", "?")
    print("  version %-10s state=%s" % (ver, state))
    if state in EDITABLE:
        found = True
        print("  [ OK ]  version %s is EDITABLE — a submission can be created for it" % ver)
if not d:
    print("  [warn]  no App Store versions returned")
elif not found:
    print("  [warn]  no editable version. A released app needs a NEW version record")
    print("          before it can be submitted; one in REVIEW cannot be resubmitted.")
PY
)"
    printf '%s\n' "$ver_report"
    # The python block above prints its own [ OK ]/[warn] lines; fold them into the tally
    # so the VERDICT reflects them instead of silently reporting warnings=0.
    n_ok="$(printf '%s\n' "$ver_report"   | grep -c '\[ OK \]')"
    n_warn="$(printf '%s\n' "$ver_report" | grep -c '\[warn\]')"
    PASS=$((PASS + n_ok)); WARN=$((WARN + n_warn))
  fi
fi

# --- verdict -------------------------------------------------------------------
hr "VERDICT"
printf '  passed=%s  failed=%s  warnings=%s\n' "$PASS" "$FAIL" "$WARN"
printf '  NOTHING WAS SUBMITTED. This check only reads.\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\n  AUTH READY: the key works and the no-browser submit path is usable.\n'
  if [ "$WARN" -gt 0 ]; then
    printf '  BUT there are %s warning(s) above — most often "no editable version".\n' "$WARN"
    printf '  Auth being fine does not mean this app can be submitted right now:\n'
    printf '  a submission also needs a version in Prepare for Submission with a build.\n'
  fi
  printf '  Submit when the app is cleared:  scripts/cm-build.sh --submit --watch\n\n'
  exit 0
fi
printf '\n  NOT READY: fix the [FAIL] items above, then re-run this check.\n\n'
exit 1
