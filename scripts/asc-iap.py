#!/usr/bin/env python3
"""
asc-iap.py — finish the "Small Tip" in-app purchase so it can be submitted.

App Store Connect holds the product but has never had it completed, so it sits in
MISSING_METADATA — and an IAP in MISSING_METADATA cannot be attached to a review
submission at all. Three things are missing, and Apple does not tell you which:

    a price          (the price schedule exists but has NO manual price on it)
    a review screenshot   (mandatory for every IAP; shows a reviewer where it is)
    territory availability

This fills them in. It is idempotent — anything already correct is reported and
skipped — so a failed run is safe to re-run.

GATES
  1. Without --apply every call is a GET and it prints a plan. That is the default.
  2. It only ever touches the ONE product id below. It cannot create, delete or
     price anything else, and it never touches the app version or a submission —
     that is scripts/asc-release.py's job, behind its own gates.

WHY IT RUNS IN CODEMAGIC
The App Store Connect key is not on anyone's Mac; Codemagic writes it into the
build from `integrations: app_store_connect:`. See scripts/asc-auth-check.sh.

    scripts/cm-build.sh -w asc-iap --watch                    # plan
    scripts/cm-build.sh -w asc-iap --env APPLY_IAP=true --watch   # write
"""
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from asc_submit import Asc, AscError, Credentials, attrs, iap_state, log  # noqa: E402

PRODUCT_ID = "com.jonathanbiles.slowburn.tip.small"
PRICE_USD = "1.99"            # what the app has always shown for this tip
BASE_TERRITORY = "USA"
SHOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "store", "iap", "small-tip-review.png")

# What a reviewer needs in order to not have to guess. Kept short and factual;
# the long version lives in the app version's own review notes.
REVIEW_NOTE = (
    "Optional tip jar. Slow Burn is a paid app and this purchase UNLOCKS NOTHING — "
    "the app is identical before and after it. Where to find it: last tab (\"Us\" / "
    "\"You\") -> scroll to the bottom -> \"Support Slow Burn\" card -> \"Leave a tip\". "
    "See the attached screenshot. A completed tip only adds a thank-you line to that "
    "same card. No stage, deck, practice, theme or setting is gated on it."
)


def show(label, value):
    log("  %-40s %s" % (label, value))


def _upload(op, blob):
    """One chunk of Apple's asset upload. Not JSON, so it does not go through Asc."""
    part = blob[op["offset"]:op["offset"] + op["length"]]
    req = urllib.request.Request(op["url"], data=part, method=op["method"])
    for h in op.get("requestHeaders") or []:
        req.add_header(h["name"], h["value"])
    with urllib.request.urlopen(req, timeout=180) as resp:
        if resp.status not in (200, 201, 204):
            raise AscError("asset upload chunk failed: HTTP %s" % resp.status)


def run(apply_changes):
    creds = Credentials()
    missing = creds.missing()
    if missing:
        raise AscError("missing credentials: " + ", ".join(missing))
    api = Asc(creds, dry=not apply_changes)

    log("== Complete the in-app purchase %s ==" % PRODUCT_ID)
    log("   mode: %s" % ("APPLY (this run WILL write to App Store Connect)"
                         if apply_changes else "PLAN ONLY (read-only)"))

    app_id = os.environ.get("ASC_APP_ID") or ""
    iaps = api.get_all("/v1/apps/%s/inAppPurchasesV2?limit=200" % app_id)
    iap = next((i for i in iaps if attrs(i).get("productId") == PRODUCT_ID), None)
    if iap is None:
        raise AscError("app %s has no in-app purchase %s" % (app_id, PRODUCT_ID))
    iid = iap["id"]
    log("")
    show("id", iid)
    show("name", attrs(iap).get("name"))
    show("type", attrs(iap).get("inAppPurchaseType"))
    show("state (before)", attrs(iap).get("state"))

    # --- 1. localization -------------------------------------------------------------
    locs = api.get_all("/v2/inAppPurchases/%s/inAppPurchaseLocalizations?limit=20" % iid)
    log("\n1. localizations")
    for l in locs:
        a = attrs(l)
        show("  " + str(a.get("locale")),
             "%s / %s (%s)" % (a.get("name"), a.get("description"), a.get("state")))
    if not locs:
        raise AscError("no localization — that must be created in App Store Connect first.")

    # --- 2. price --------------------------------------------------------------------
    log("\n2. price")
    prices = api.get_all("/v1/inAppPurchasePriceSchedules/%s/manualPrices?limit=20" % iid)
    if prices:
        show("  manual prices", "%d already set — leaving alone" % len(prices))
    else:
        show("  manual prices", "NONE — this is why it is in MISSING_METADATA")
        points = api.get_all("/v2/inAppPurchases/%s/pricePoints?filter[territory]=%s&limit=200"
                             % (iid, BASE_TERRITORY))
        pt = next((p for p in points if attrs(p).get("customerPrice") == PRICE_USD), None)
        if pt is None:
            raise AscError("no %s %s price point exists for this product" % (PRICE_USD, BASE_TERRITORY))
        show("  chose price point", "%s %s (proceeds %s)"
             % (PRICE_USD, BASE_TERRITORY, attrs(pt).get("proceeds")))
        api.request("POST", "/v1/inAppPurchasePriceSchedules", {
            "data": {
                "type": "inAppPurchasePriceSchedules",
                "relationships": {
                    "inAppPurchase": {"data": {"type": "inAppPurchases", "id": iid}},
                    "baseTerritory": {"data": {"type": "territories", "id": BASE_TERRITORY}},
                    "manualPrices": {"data": [{"type": "inAppPurchasePrices", "id": "${p}"}]}}},
            "included": [{
                "type": "inAppPurchasePrices", "id": "${p}",
                "attributes": {"startDate": None, "endDate": None},
                "relationships": {"inAppPurchasePricePoint": {
                    "data": {"type": "inAppPurchasePricePoints", "id": pt["id"]}}}}]})
        show("  set price", "$%s (base territory %s)" % (PRICE_USD, BASE_TERRITORY))

    # --- 3. availability -------------------------------------------------------------
    log("\n3. territory availability")
    terrs = []
    try:
        terrs = api.get_all("/v1/inAppPurchaseAvailabilities/%s/availableTerritories?limit=200" % iid)
    except AscError:
        pass
    if terrs:
        show("  available in", "%d territories — leaving alone" % len(terrs))
    else:
        show("  available in", "NONE — an IAP with no territory stays in MISSING_METADATA")
        all_terrs = api.get_all("/v1/territories?limit=200")
        show("  will enable", "%d territories (everywhere the app is sold)" % len(all_terrs))
        api.request("POST", "/v1/inAppPurchaseAvailabilities", {
            "data": {
                "type": "inAppPurchaseAvailabilities",
                "attributes": {"availableInNewTerritories": True},
                "relationships": {
                    "inAppPurchase": {"data": {"type": "inAppPurchases", "id": iid}},
                    "availableTerritories": {"data": [
                        {"type": "territories", "id": t["id"]} for t in all_terrs]}}}})

    # --- 4. the App Review screenshot ------------------------------------------------
    log("\n4. App Review screenshot")
    existing = None
    try:
        existing = (api.request("GET", "/v2/inAppPurchases/%s/appStoreReviewScreenshot" % iid)
                    or {}).get("data")
    except AscError:
        pass
    if existing:
        show("  screenshot", "already uploaded (%s) — leaving alone"
             % attrs(existing).get("assetDeliveryState"))
    elif not os.path.isfile(SHOT):
        raise AscError("no screenshot at %s — run `npm run shots:iap` and commit it." % SHOT)
    else:
        blob = open(SHOT, "rb").read()
        show("  uploading", "%s (%d KB)" % (os.path.basename(SHOT), len(blob) // 1024))
        doc = api.request("POST", "/v1/inAppPurchaseAppStoreReviewScreenshots", {
            "data": {"type": "inAppPurchaseAppStoreReviewScreenshots",
                     "attributes": {"fileName": os.path.basename(SHOT), "fileSize": len(blob)},
                     "relationships": {"inAppPurchaseV2": {
                         "data": {"type": "inAppPurchases", "id": iid}}}}})
        if apply_changes:
            res = doc["data"]
            for op in attrs(res).get("uploadOperations") or []:
                _upload(op, blob)
            # Apple verifies the checksum; a wrong one leaves the asset FAILED with
            # no other symptom than the IAP never leaving MISSING_METADATA.
            api.request("PATCH", "/v1/inAppPurchaseAppStoreReviewScreenshots/%s" % res["id"], {
                "data": {"type": "inAppPurchaseAppStoreReviewScreenshots", "id": res["id"],
                         "attributes": {"uploaded": True,
                                        "sourceFileChecksum": hashlib.md5(blob).hexdigest()}}})
            show("  uploaded", "checksum accepted")

    # --- 5. the review note ----------------------------------------------------------
    log("\n5. review note")
    if attrs(iap).get("reviewNote"):
        show("  note", "already set — leaving alone")
    else:
        api.request("PATCH", "/v2/inAppPurchases/%s" % iid, {
            "data": {"type": "inAppPurchases", "id": iid,
                     "attributes": {"reviewNote": REVIEW_NOTE}}})
        show("  set note", REVIEW_NOTE[:70] + "…")

    # --- 6. did it work? -------------------------------------------------------------
    log("\n6. resulting state")
    if not apply_changes:
        log("   [plan] nothing was written. Re-run with APPLY_IAP=true.")
        return 0
    after = api.request("GET", "/v2/inAppPurchases/%s" % iid).get("data")
    rollup = attrs(after).get("state")
    state = iap_state(api, after)
    show("  state (after)", state)
    if rollup != state:
        # Read iap_state()'s docstring. The rollup attribute goes stale the moment you
        # write to a product; the version is what App Store Connect's own UI shows.
        show("  rollup field says", "%s — STALE, ignore it" % rollup)
    if state == "MISSING_METADATA":
        raise AscError(
            "still MISSING_METADATA. Something above did not take — read the section that\n"
            "  did NOT say it was skipping, and check the asset's deliveryState. An IAP in\n"
            "  this state cannot be attached to a review submission at all.")
    log("\n== the in-app purchase is %s — it can now ride with the app version ==" % state)
    return 0


if __name__ == "__main__":
    apply_changes = os.environ.get("APPLY_IAP", "false") == "true" or "--apply" in sys.argv
    try:
        sys.exit(run(apply_changes))
    except AscError as exc:
        print("\nasc-iap: %s" % exc, file=sys.stderr)
        sys.exit(1)
