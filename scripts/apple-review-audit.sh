#!/usr/bin/env bash
# APPLE REVIEW GATE — run with `npm run audit:apple`.
# ---------------------------------------------------------------------------
# Everything that has ever got Slow Burn rejected, or would reject it at
# upload, checked in one place. Exits non-zero on any BLOCK.
#
#   BLOCK  submission will fail validation or review
#   WARN   worth a look, not fatal
#   PASS   verified
#
# This does NOT build. It reads the repo, the build lane, and the live
# privacy page.
set -uo pipefail
cd "$(dirname "$0")/.."

BLOCK=0; WARN=0
pass(){ printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn(){ printf '  \033[33mWARN\033[0m  %s\n' "$1"; WARN=$((WARN+1)); }
block(){ printf '  \033[31mBLOCK\033[0m %s\n' "$1"; BLOCK=$((BLOCK+1)); }
sec(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

BUNDLE_ID="com.jonathanbiles.slowburn"
PRIVACY_URL="https://jonathanbbiles.github.io/app-privacy/slowburn.html"
APP=www/index.html
CM=codemagic.yaml

sec "1. Privacy — the wire, and the page"
if npm test >/tmp/sb-audit-tests.log 2>&1; then
  pass "npm test green (privacy wire audit + end-to-end crypto test)"
else
  block "npm test FAILED — see /tmp/sb-audit-tests.log"
fi
CODE=$(curl -s -o /tmp/sb-privacy.html -w '%{http_code}' "$PRIVACY_URL" || echo 000)
if [ "$CODE" = "200" ]; then
  pass "privacy page live (200): $PRIVACY_URL"
  for phrase in "end-to-end encrypted" "never crosses" "safety word" "jonathanbbiles@gmail.com"; do
    grep -qi "$phrase" /tmp/sb-privacy.html \
      && pass "privacy page states: \"$phrase\"" \
      || block "privacy page is missing: \"$phrase\""
  done
  grep -qi "not medical advice" /tmp/sb-privacy.html \
    && pass "privacy page carries the not-medical-advice disclaimer" \
    || warn "privacy page has no not-medical-advice disclaimer"
else
  block "privacy page did not return 200 (got $CODE): $PRIVACY_URL"
fi

sec "2. Guideline 4 — iPad"
if grep -q 'TARGETED_DEVICE_FAMILY = "1"' "$CM"; then
  pass "build lane forces iPhone-only (TARGETED_DEVICE_FAMILY = 1)"
else
  block "build lane does not force iPhone-only — Capacitor defaults to \"1,2\" (iPad), which took a Guideline 4 rejection before"
fi
if grep -q 'class="notch"' "$APP" && ! grep -q '\.notch{display:none}' "$APP"; then
  block "the fake device notch/bezel is visible again — that WAS the Guideline 4 rejection"
else
  pass "no device-frame mockup in the app shell"
fi
grep -q 'min-height:100vh' "$APP" && pass "app fills the viewport at any size" \
  || warn "app may not fill the viewport — check the shell CSS"

sec "3. Export compliance"
if grep -q 'ITSAppUsesNonExemptEncryption' "$CM"; then
  if grep -q 'ITSAppUsesNonExemptEncryption bool false' "$CM"; then
    pass "ITSAppUsesNonExemptEncryption=false is set by the build lane"
    grep -qi 'EXPORT COMPLIANCE' "$CM" \
      && pass "the determination is recorded next to the flag" \
      || warn "no note recording WHY the exemption applies now that the app encrypts"
  else
    warn "ITSAppUsesNonExemptEncryption is referenced but not set to false"
  fi
else
  block "ITSAppUsesNonExemptEncryption is not set — every upload will stall on the export-compliance prompt"
fi
grep -q "crypto.subtle" "$APP" \
  && pass "encryption is WebCrypto (provided by iOS/WebKit), not a bundled crypto library" \
  || warn "could not confirm the app uses the OS WebCrypto implementation"

sec "4. App icon"
if [ -f appicon-1024.png ]; then
  ALPHA=$(sips -g hasAlpha appicon-1024.png 2>/dev/null | awk '/hasAlpha/{print $2}')
  W=$(sips -g pixelWidth appicon-1024.png 2>/dev/null | awk '/pixelWidth/{print $2}')
  H=$(sips -g pixelHeight appicon-1024.png 2>/dev/null | awk '/pixelHeight/{print $2}')
  [ "$W" = "1024" ] && [ "$H" = "1024" ] && pass "icon is 1024x1024" || block "icon is ${W}x${H}, must be 1024x1024"
  [ "$ALPHA" = "no" ] && pass "icon has no alpha channel" \
    || block "icon HAS an alpha channel — upload fails with ITMS-90717"
else
  block "appicon-1024.png is missing"
fi

sec "5. Guideline 2.1(b) — no dead purchase buttons"
if grep -q 'Monetize.ready()' "$APP"; then
  pass "tip buttons render only when Apple returned purchasable products"
else
  block "the tip jar is not gated on Monetize.ready() — a dead buy button is a 2.1(b) rejection"
fi
grep -q 'verified(r=>{ r.finish(); recordTip(); })' "$APP" \
  && pass "a tip is recorded only inside .verified() — no mock grants" \
  || warn "could not confirm tips are granted only from .verified()"

sec "6. Network + links"
if grep -qE 'http://[^"]' "$APP"; then
  block "app references a plaintext http:// resource — ATS will block it"
else
  pass "no plaintext http:// resources"
fi
grep -q 'function openSite' "$APP" \
  && pass "external links open in the system browser (no dead in-webview navigation)" \
  || warn "openSite() helper not found — links may dead-navigate inside the webview"
grep -q 'find-clinician' "$APP" \
  && pass "clinician-referral path present (wellness-app expectation)" \
  || warn "no clinician referral path"

sec "7. Store assets"
SHOTS=store/screenshots
need_shot(){ # label WxH
  local n; n=$(find "$SHOTS" -name '*.png' 2>/dev/null | while read -r f; do
    d=$(sips -g pixelWidth -g pixelHeight "$f" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}')
    [ "$d" = "$2" ] && echo "$f"; done | wc -l | tr -d ' ')
  if [ "${n:-0}" -ge 3 ]; then pass "$1: $n screenshots at $2"
  elif [ "${n:-0}" -gt 0 ]; then warn "$1: only $n screenshot(s) at $2 (App Store wants at least 3)"
  else block "$1: no screenshots at $2"; fi
}
if [ -d "$SHOTS" ]; then
  need_shot "iPhone 6.9\"" "1290x2796"
  need_shot "iPhone 6.5\"" "1284x2778"
  IPAD=$(find "$SHOTS" -name 'ipad*' 2>/dev/null | wc -l | tr -d ' ')
  [ "$IPAD" = "0" ] && pass "no iPad screenshots (correct for an iPhone-only app)" \
    || warn "$IPAD iPad screenshot(s) present but the app ships iPhone-only — remove them from App Store Connect"
  # Screenshots must show the SHIPPING copy. They go stale only when the app
  # itself changes, so compare against the last commit that touched www/.
  if [ -f "$SHOTS/MANIFEST.txt" ]; then
    pass "screenshot manifest present ($SHOTS/MANIFEST.txt)"
    APPREV=$(git log -1 --format=%h -- "$APP" 2>/dev/null || echo "")
    if [ -z "$APPREV" ]; then
      warn "not a git checkout — cannot verify the screenshots match the app"
    elif grep -q "$APPREV" "$SHOTS/MANIFEST.txt" 2>/dev/null; then
      pass "screenshots match the current $APP ($APPREV)"
    else
      warn "$APP changed since the screenshots were taken — re-run \`npm run shots\` and re-read the copy in them"
    fi
  else
    warn "no $SHOTS/MANIFEST.txt — cannot tell which build the screenshots came from"
  fi
else
  block "no $SHOTS directory"
fi
[ -f store/store-listing.md ] && pass "store listing copy present" || warn "no store/store-listing.md"

sec "8. Config sanity"
grep -q "\"appId\": \"$BUNDLE_ID\"" capacitor.config.json \
  && pass "bundle id is $BUNDLE_ID" || block "capacitor.config.json appId does not match $BUNDLE_ID"
# Only an UNcommented line counts — the lane documents the toggle in a comment.
if grep -qE '^[[:space:]]*submit_to_app_store:[[:space:]]*true' "$CM" 2>/dev/null; then
  warn "submit_to_app_store is ON — every green build will submit itself for review"
else
  pass "auto-submit-to-review is off (TestFlight only)"
fi

printf '\n\033[1mVERDICT\033[0m  '
if [ "$BLOCK" -gt 0 ]; then
  printf '\033[31mBLOCKED\033[0m — %d blocking, %d warning(s)\n' "$BLOCK" "$WARN"; exit 1
fi
printf '\033[32mPASS\033[0m — 0 blocking, %d warning(s)\n' "$WARN"
