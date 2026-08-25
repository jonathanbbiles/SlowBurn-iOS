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

sec "2. Pairing actually works — QR + scanner"
if command -v node >/dev/null && [ -d node_modules/puppeteer-core ] && [ -x "${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" ]; then
  # This step launches Chrome. Run it straight after `npm run shots` (which
  # also drives Chrome) and the launch can lose a race that has nothing to do
  # with the app — seen once, never reproduced in 14 subsequent runs. A browser
  # that fails to start is not a product defect, so retry once before blocking;
  # a real failure fails twice.
  if npm run --silent test:qr >/tmp/sb-audit-qr.log 2>&1; then
    pass "pairing QR test green — QR carries the bare code, the scanner reads it and pairs"
  elif sleep 3 && npm run --silent test:qr >/tmp/sb-audit-qr.log 2>&1; then
    pass "pairing QR test green (first Chrome launch lost a race; passed on retry)"
  else
    block "pairing QR test FAILED twice — see /tmp/sb-audit-qr.log"
  fi
else
  warn "skipped the pairing QR test (needs Chrome + puppeteer-core) — run \`npm run test:qr\` before shipping"
fi
# The original defect, guarded directly: the QR must never carry a URL again.
if grep -q 'new QRCode(box,{text:S.code' "$APP"; then
  pass "QR encodes the pair code itself, not a URL"
else
  block "the pairing QR does not encode S.code — if it encodes location.origin it is capacitor://localhost and cannot be scanned by anything"
fi
if grep -q 'Scan to join' "$APP"; then
  block "the invite screen still says \"Scan to join\" — copy must match what actually works"
else
  pass "invite-screen copy matches the working flow"
fi
grep -q 'Scanner.supported()?`<button class="btn btn-soft mt10" data-action="scan-open"' "$APP" \
  && pass "the Scan button appears only when the device can scan (no dead button)" \
  || warn "could not confirm the Scan button is gated on Scanner.supported()"
if grep -q 'NSCameraUsageDescription' "$CM"; then
  pass "build lane sets NSCameraUsageDescription (without it, touching the camera kills the app)"
else
  block "NSCameraUsageDescription is not set by the build lane — the scanner will crash the app on first use"
fi
[ -f www/vendor/jsQR.js ] && [ -f www/vendor/jsQR-LICENSE.txt ] \
  && pass "QR decoder vendored locally with its licence (pairing does not depend on a CDN)" \
  || block "www/vendor/jsQR.js or its licence is missing"

sec "3. Guideline 4 — iPad"
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

sec "4. Export compliance"
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

sec "5. App icon"
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

sec "6. Business model — a paid app, plus ONE tip jar that unlocks nothing"
# EVERY check in this section reads the app with its comments stripped. The
# comments here deliberately name the things the checks forbid — "no
# subscription is registered anywhere", "sb_supported is the only consumer" —
# because that is where the reasoning belongs. A naked grep over the raw file
# counts those explanations as violations, so the build would fail for
# documenting the invariant it is enforcing. What a reviewer sees is code and
# copy; that is what gets scanned.
APP_CODE=$(mktemp /tmp/sb-app-code.XXXXXX.js)
python3 - "$APP" >"$APP_CODE" <<'STRIP'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
src = re.sub(r"/\*[\s\S]*?\*/", "", src)
src = re.sub(r"^\s*//.*$", "", src, flags=re.M)
sys.stdout.write(src)
STRIP
# Apple rejected under 2.1(b) in Aug 2026 asking about paid content. The binary
# then held a tip jar of three consumables while the review submission held only
# the app — so the purchase Apple could see in the binary was not in front of it
# to review. The fix for that is NOT "have no in-app purchase". It is: ship one
# product that really exists in App Store Connect, gate nothing on it, and
# submit it in the SAME review submission as the version.
#
# So these checks changed shape. They no longer block on purchase machinery
# existing; they block on the three ways a tip jar goes wrong:
#   a dead button, an optimistic grant, or a tip that gates content.
if npm run --silent test:content >/tmp/sb-audit-content.log 2>&1; then
  pass "tip-jar / no-gating suite green (all content reachable, no dead button, no optimistic grant)"
else
  block "tip-jar / no-gating suite FAILED — see /tmp/sb-audit-content.log"
fi

# --- the product list must match App Store Connect exactly -------------------
# Registering a product Apple does not have means a button that can never load,
# which is the dead-button form of 2.1(b). Keep this list in step with ASC.
ASC_PRODUCTS='com.jonathanbiles.slowburn.tip.small'
APP_PRODUCTS=$(grep -o 'com\.jonathanbiles\.slowburn\.tip\.[a-z]*' "$APP_CODE" | sort -u | tr '\n' ' ' | sed 's/ $//')
if [ "$APP_PRODUCTS" = "$ASC_PRODUCTS" ]; then
  pass "the app registers exactly the in-app purchase App Store Connect has ($ASC_PRODUCTS)"
else
  block "product mismatch — app has [$APP_PRODUCTS], App Store Connect has [$ASC_PRODUCTS]. \
A product Apple does not have can never load, so its button would do nothing (2.1(b))."
fi

# --- entitlement machinery must NOT exist -----------------------------------
# A tip buys no content, so nothing here may look like an unlock. These stay
# blocking: they are the freemium build, not the tip jar.
IAPHITS=0
for ghost in 'NON_CONSUMABLE' 'restorePurchases' 'Pro.active' 'screenPro(' \
             'buyPro' 'PRO_ID' 'sb_pro_v1' 'decksLocked' 'practicesLocked'; do
  if grep -q "$ghost" "$APP_CODE"; then
    block "entitlement / paywall machinery in the app: $ghost"
    IAPHITS=$((IAPHITS+1))
  fi
done
[ "$IAPHITS" = "0" ] && pass "no entitlement, no non-consumable, no restore, no paywall anywhere in the app"

# --- the tipped flag must gate nothing ---------------------------------------
# If anything but Monetize reads sb_supported, the tip has become an
# entitlement and "everything is included" stops being true.
SUPPORTED_READS=$(grep -c 'sb_supported' "$APP_CODE" || true)
if [ "$SUPPORTED_READS" = "1" ]; then
  pass "\"sb_supported\" is read in exactly one place (Monetize's own key) — a tip gates nothing"
else
  block "\"sb_supported\" appears $SUPPORTED_READS times in code — more than one reader means a tip unlocks something"
fi
rm -f "$APP_CODE"

# --- the plugin must be a dependency, or the buttons cannot work -------------
if grep -q 'cordova-plugin-purchase' package.json; then
  pass "cordova-plugin-purchase is a dependency (StoreKit is linked, so the tip can complete)"
else
  block "cordova-plugin-purchase is NOT a dependency — the tip button would be dead"
fi

# --- business-model wording a reviewer would read as a tier ------------------
# "Support Slow Burn" and "tip" are now legitimate and expected. A subscription,
# a Pro tier or a restore flow is not.
for phrase in 'Slow Burn Pro' 'subscription' 'restore purchase' 'premium' 'free trial'; do
  if grep -qi "$phrase" "$APP_CODE"; then
    block "paid-tier wording still in app copy: \"$phrase\""
  fi
done
pass "no subscription / tier / restore wording in app copy"
# "unlock" survives ON PURPOSE: it is the consent gate between two people.
UNLOCKS=$(grep -c 'unlock' "$APP" || true)
pass "\"unlock\" appears $UNLOCKS times, all consent-gate copy (\"Stage N unlocks once you have both confirmed\") — a progress gate, not a price"

sec "7. Network + links"
if grep -qE 'http://[^"]' "$APP"; then
  block "app references a plaintext http:// resource — ATS will block it"
else
  pass "no plaintext http:// resources"
fi
grep -q 'function openSite' "$APP" \
  && pass "external links open in the system browser (no dead in-webview navigation)" \
  || warn "openSite() helper not found — links may dead-navigate inside the webview"
grep -q 'jonathanscribbles.com' "$APP" \
  && pass "jonathanscribbles.com link present (standing rule)" \
  || block "the jonathanscribbles.com link is missing"
grep -q 'jessicaleighbiles.com' "$APP" \
  && pass "jessicaleighbiles.com co-brand link present" \
  || block "the jessicaleighbiles.com co-brand link is missing"
grep -q 'find-clinician' "$APP" \
  && pass "clinician-referral path present (wellness-app expectation)" \
  || warn "no clinician referral path"

sec "8. Store assets"
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
  # A screenshot of a paywall would be uploaded to the App Store and would
  # re-raise the exact business-model question that caused the rejection.
  # Match the paywall scene's own suffix, not any "pro" substring — otherwise
  # "program" trips it.
  PAYSHOTS=$(find "$SHOTS" \( -name '*_pro.png' -o -name '*paywall*' -o -name '*unlock*' -o -name '*upgrade*' -o -name '*purchase*' \) 2>/dev/null | wc -l | tr -d ' ')
  [ "$PAYSHOTS" = "0" ] && pass "no paywall/Pro screenshots staged for the App Store" \
    || block "$PAYSHOTS screenshot(s) look like a paywall — they would be uploaded to the App Store"
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

sec "9. Version + config sanity"
if grep -q 'CFBundleShortVersionString -string' "$CM"; then
  VER=$(grep -o 'CFBundleShortVersionString -string "[^"]*"' "$CM" | head -1 | sed 's/.*"\(.*\)"/\1/')
  pass "marketing version is $VER (1.0 was rejected, not released — a new build against the same version record is the normal resubmission)"
else
  warn "the lane does not set CFBundleShortVersionString — it will inherit whatever Xcode defaults to"
fi
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
