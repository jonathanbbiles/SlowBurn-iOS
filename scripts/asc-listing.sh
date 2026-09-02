#!/usr/bin/env bash
#
# asc-listing.sh — drive the App Store Connect listing lane from Codemagic.
#
# RUNS INSIDE CODEMAGIC. It picks the mode, proves the credentials arrived, sets the
# environment fastlane needs on a headless machine, and hands over to fastlane.
#
# MODE SELECTION — one flag is all Jonathan ever has to think about
#
#     SUBMIT_FOR_REVIEW=true      ->  submit    (upload the listing AND submit for review)
#     ASC_LISTING_MODE=push       ->  push      (upload the listing, do not submit)
#     anything else               ->  validate  (DEFAULT: read-only, writes nothing)
#
# SUBMIT_FOR_REVIEW is deliberately NOT declared in codemagic.yaml. It can only arrive as a
# per-build override:
#
#     scripts/cm-build.sh --submit --watch
#
# so an ordinary push can never submit anything — the variable simply is not there. That is
# the safe default by construction rather than by remembering to flip a value back.
#
# ADVISORY MODE
# On the TestFlight workflow this script runs as a post-publish step, after the IPA has
# already shipped. A validate failure there must not repaint a successful TestFlight build
# as failed, so that step sets ASC_LISTING_ADVISORY=true: the result is printed, the exit
# code is 0. The dedicated validation workflow leaves it unset, so failures show red.
# Advisory NEVER applies to push or submit — a write that failed is a real failure.
#
# SECRETS are referenced by NAME only and never echoed. Build logs are not private.

set -uo pipefail

say() { printf '    %s\n' "$*"; }
hr() { printf '\n== %s\n' "$*"; }

MODE="${ASC_LISTING_MODE:-validate}"
if [ "${SUBMIT_FOR_REVIEW:-false}" = "true" ]; then
  MODE="submit"
fi

case "$MODE" in
  validate | push | submit) ;;
  *)
    say "ASC_LISTING_MODE='$MODE' is not one of: validate, push, submit."
    exit 1
    ;;
esac

ADVISORY="${ASC_LISTING_ADVISORY:-false}"
# A write is never advisory.
if [ "$MODE" != "validate" ]; then
  ADVISORY="false"
fi

hr "App Store Connect listing — mode: $MODE"
case "$MODE" in
  validate) say "Read-only. Nothing will be uploaded and nothing will be submitted." ;;
  push) say "Will upload metadata + screenshots to the editable version. Will NOT submit." ;;
  submit) say "Will upload the listing AND submit the app for App Store review." ;;
esac
[ "$ADVISORY" = "true" ] && say "Advisory: this step reports its result but cannot fail the build."

# --- The build that got here must be good --------------------------------------------
# Publishing scripts run regardless of build status, so a failed build would otherwise
# still try to submit itself.
if [ "$MODE" = "submit" ] && [ "${CM_BUILD_STEP_STATUS:-success}" != "success" ]; then
  say "A previous step reported '${CM_BUILD_STEP_STATUS}' — refusing to submit a bad build."
  exit 1
fi

# --- Credentials, by name only --------------------------------------------------------
hr "App Store Connect credentials in this build"
# APP_STORE_CONNECT_PRIVATE_KEY is NOT in this list. The key is not always in the variable:
# Codemagic can leave it as a .p8 under ~/.appstoreconnect/private_keys/. Whether a usable
# key exists at all is decided below by asc_key_pem.rb, which checks both places — treating
# an empty variable as fatal here would reject a build whose key is simply on disk.
missing=0
for v in APP_STORE_CONNECT_KEY_IDENTIFIER APP_STORE_CONNECT_ISSUER_ID; do
  if [ -z "${!v:-}" ]; then
    say "MISSING: $v"
    missing=1
  else
    say "present: $v"
  fi
done

if [ "$missing" -ne 0 ]; then
  cat <<'EOF'

    Those three variables are what fastlane authenticates with. They are supposed to come
    from `integrations: app_store_connect: <key name>` in codemagic.yaml.

    If they are missing, that integration wires the key into Codemagic's OWN publishing
    step but does not export it to scripts. FIX (one-time per app, and only Jonathan can
    do it — these are secret): Codemagic -> the app -> Environment variables -> add the
    SAME key from Team Integrations as three SECURE variables:

        APP_STORE_CONNECT_KEY_IDENTIFIER    the key id
        APP_STORE_CONNECT_ISSUER_ID         the issuer id
        APP_STORE_CONNECT_PRIVATE_KEY       the full .p8 text, BEGIN/END lines included

    Never hardcode a key in the repo.
EOF
  [ "$ADVISORY" = "true" ] && { say "(advisory — not failing the build)"; exit 0; }
  exit 1
fi

# --- fastlane on a headless machine ---------------------------------------------------
# fastlane aborts on a non-UTF-8 locale, and the listing text contains em dashes.
export LC_ALL=en_US.UTF-8
export LANG=en_US.UTF-8
export FASTLANE_SKIP_UPDATE_CHECK=1
export FASTLANE_HIDE_CHANGELOG=1
export FASTLANE_DISABLE_COLORS=1
# Never sit waiting on stdin that will never arrive.
export FASTLANE_OPT_OUT_USAGE=1

# --- Lint the listing before anything touches the network -----------------------------
# Plain Ruby, no fastlane, no network. Runs in every mode: catching an over-length keyword
# here costs a second, and catching it from a rejection costs a review cycle.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

hr "App Store Connect private key"
if ! ruby "$REPO_ROOT/scripts/asc_key_pem.rb"; then
  say "No usable private key — see the list above of everything that was tried."
  [ "$ADVISORY" = "true" ] && { say "(advisory — not failing the build)"; exit 0; }
  exit 1
fi

hr "Listing lint (local files only)"
if ! ruby "$REPO_ROOT/scripts/lint_listing.rb" "$REPO_ROOT"; then
  say "The listing in fastlane/ is not submittable. Nothing was sent to Apple."
  [ "$ADVISORY" = "true" ] && { say "(advisory — not failing the build)"; exit 0; }
  exit 1
fi

# The repo root, resolved by bash from this script's own location. fastlane's working
# directory during a lane is not reliably the repo root, so the Fastfile is told rather
# than left to guess.
export ASC_REPO_ROOT="$REPO_ROOT"

hr "fastlane"
fastlane --version || true

case "$MODE" in
  validate) LANE="asc_validate" ;;
  push) LANE="asc_push" ;;
  submit) LANE="asc_submit" ;;
esac

say "running: fastlane ios $LANE"
fastlane ios "$LANE"
rc=$?

hr "Result"
if [ "$rc" -eq 0 ]; then
  case "$MODE" in
    validate) say "VALIDATE PASSED — the key authenticates and the listing is well formed. Nothing was written." ;;
    push) say "PUSH COMPLETE — listing uploaded, NOT submitted." ;;
    submit) say "SUBMITTED FOR REVIEW." ;;
  esac
  exit 0
fi

say "fastlane exited $rc (mode: $MODE)."
if [ "$ADVISORY" = "true" ]; then
  say "Advisory step — the build's TestFlight result stands. Fix this before trying to submit:"
  say "    push the branch asc-validate-<something> and read the check run on that commit"
  exit 0
fi
exit "$rc"
