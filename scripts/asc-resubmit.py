#!/usr/bin/env python3
"""
asc-resubmit.py — withdraw Slow Burn 1.0 from review and resubmit it WITH the tip jar.

WHY THIS EXISTS AND ASC-RELEASE DOES NOT DO IT
asc-release.py prepares a NEW version. This is the other case: version 1.0 is already
with Apple, in a submission that contains the app and nothing else, while the "Small
Tip" in-app purchase sits outside it. That is the 2.1(b) split — Apple reviews the app,
and the purchase in the binary is not in front of them. Fixing it costs the queue
position, because items cannot be added to a submission Apple already has:

    withdraw the submission  ->  the version becomes editable again
    attach the new build     ->  the binary that actually contains the tip jar
    write the review notes   ->  from store/review-notes.txt, which is in git
    resubmit with BOTH items ->  handed to asc_submit.py, which refuses on 1 item

THE ORDER MATTERS AND IS NOT NEGOTIABLE. The in-app purchase must be READY_TO_SUBMIT
BEFORE the withdrawal, because an IAP in MISSING_METADATA cannot be attached to a
submission at all — withdrawing first would leave the app out of the queue AND still
unable to go back in with its purchase. So this refuses to withdraw anything until it
has read the IAP and seen that it is ready. Run scripts/asc-iap.py first.

GATES
  1. --submit. Without it every call is a GET and it prints a plan. That is the default.
  2. --build must name the build a human has approved, and it must be VALID in App Store
     Connect with a CFBundleShortVersionString equal to --version. asc_submit.py checks
     the same thing again from its own side; both have to agree.

    scripts/cm-build.sh -w asc-resubmit --watch                            # plan
    scripts/cm-build.sh -w asc-resubmit --env SUBMIT_FOR_REVIEW=true --watch   # do it
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import asc_submit  # noqa: E402
from asc_submit import (Asc, AscError, Credentials, attrs, log,  # noqa: E402
                        submission_kinds, version_state, _wait_cancelled)

NOTES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "store", "review-notes.txt")
NOTES_MAX = 4000          # App Store Connect's limit on the App Review notes field


def find_iap(api, app_id, product_id):
    iaps = api.get_all(f"/v1/apps/{app_id}/inAppPurchasesV2?limit=200")
    iap = next((i for i in iaps if attrs(i).get("productId") == product_id), None)
    if iap is None:
        raise AscError(f"app {app_id} has no in-app purchase {product_id}")
    return iap


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-id", required=True)
    ap.add_argument("--version", required=True, help="version string, e.g. 1.0")
    ap.add_argument("--build", required=True, help="CFBundleVersion of the approved build")
    ap.add_argument("--product-id", required=True, help="the IAP that must ride with it")
    ap.add_argument("--submit", action="store_true")
    args = ap.parse_args(argv)

    creds = Credentials()
    missing = creds.missing()
    if missing:
        raise AscError("missing credentials: " + ", ".join(missing))
    api = Asc(creds, dry=not args.submit)

    log(f"== Resubmit {args.version} (build {args.build}) WITH {args.product_id} ==")
    log("   mode: %s" % ("SUBMIT — this run WILL withdraw and resubmit"
                         if args.submit else "PLAN ONLY (read-only; nothing will be sent)"))

    # --- 1. the in-app purchase must be ready BEFORE anything is withdrawn -------------
    iap = find_iap(api, args.app_id, args.product_id)
    state = attrs(iap).get("state")
    log(f"\n1. in-app purchase  {args.product_id}  {state}")
    if state in asc_submit.IAP_IN_FLIGHT_STATES:
        log("   already with Apple — it will not be re-attached")
    elif state not in asc_submit.IAP_NEEDS_REVIEW_STATES:
        raise AscError(
            f"the in-app purchase is {state}, not READY_TO_SUBMIT.\n"
            "  It cannot be attached to a review submission in that state, so withdrawing\n"
            "  the app now would take it out of the queue AND leave it unable to go back in\n"
            "  with its purchase. Run the `asc-iap` workflow first, then re-run this.")

    # --- 2. the build ------------------------------------------------------------------
    builds = api.get_all(f"/v1/apps/{args.app_id}/builds?limit=50")
    build = next((b for b in builds if attrs(b).get("version") == str(args.build)), None)
    if build is None:
        seen = ", ".join(attrs(b).get("version", "?") for b in builds[:8]) or "none"
        raise AscError(f"build {args.build} is not in App Store Connect (latest: {seen}).")
    if attrs(build).get("processingState") != "VALID":
        raise AscError(f"build {args.build} is {attrs(build).get('processingState')}, not VALID.")
    pre = api.request("GET", f"/v1/builds/{build['id']}/preReleaseVersion").get("data")
    short = attrs(pre).get("version") if pre else "?"
    if short != args.version:
        raise AscError(
            f"build {args.build} says CFBundleShortVersionString {short}, but the version "
            f"record is {args.version}. Apple rejects that. Fix MARKETING_VERSION and rebuild.")
    log(f"\n2. build            {args.build}  VALID  short={short}  id={build['id']}")

    # --- 3. the version ----------------------------------------------------------------
    versions = api.get_all(f"/v1/apps/{args.app_id}/appStoreVersions?limit=50")
    version = next((v for v in versions if attrs(v).get("versionString") == args.version), None)
    if version is None:
        raise AscError(f"there is no {args.version} version record.")
    vid = version["id"]
    log(f"3. version record   {args.version}  {version_state(version)}  id={vid}")

    # --- 4. withdraw the open submission ------------------------------------------------
    subs = api.get_all(f"/v1/apps/{args.app_id}/reviewSubmissions?limit=50")
    open_subs = [s for s in subs if attrs(s).get("state") in asc_submit.OPEN_SUBMISSION_STATES]
    log(f"\n4. open review submissions: {len(open_subs)}")
    for s in open_subs:
        sid = s["id"]
        kinds, items = submission_kinds(api, sid)
        log(f"   {sid}  {attrs(s).get('state')}  contains {len(items)} item(s): "
            f"{', '.join(sorted(kinds)) or 'unresolved'}")
        if "inAppPurchaseV2" in kinds and "appStoreVersion" in kinds:
            log("   this submission ALREADY contains both — nothing to withdraw.")
            continue
        # The whole reason this script exists. An item cannot be added to a submission
        # Apple already holds, so the only way to get the purchase in front of them is to
        # take the app out of the queue and put both in together.
        log("   THIS IS THE VERSION-ONLY SUBMISSION. Withdrawing it costs the queue")
        log("   position, and there is no other way to attach the in-app purchase.")
        if not args.submit:
            log("   [plan] would PATCH it to canceled and wait for Apple to release the version")
            continue
        api.request("PATCH", f"/v1/reviewSubmissions/{sid}",
                    {"data": {"type": "reviewSubmissions", "id": sid,
                              "attributes": {"canceled": True}}})
        _wait_cancelled(api, args.app_id, sid)

    # --- 5. attach the build ------------------------------------------------------------
    current = api.request("GET", f"/v1/appStoreVersions/{vid}/build").get("data")
    current_no = attrs(current).get("version") if current else None
    log(f"\n5. build on the version: {current_no or 'none'}")
    if current_no == str(args.build):
        log("   already the approved build — leaving alone")
    else:
        log(f"   attaching {args.build} (was {current_no or 'none'})")
        api.request("PATCH", f"/v1/appStoreVersions/{vid}/relationships/build",
                    {"data": {"type": "builds", "id": build["id"]}})

    # --- 6. the App Review notes ---------------------------------------------------------
    text = open(NOTES, encoding="utf-8").read().strip()
    if len(text) > NOTES_MAX:
        raise AscError(f"{NOTES} is {len(text)} characters; App Store Connect allows {NOTES_MAX}.")
    detail = api.request("GET", f"/v1/appStoreVersions/{vid}/appStoreReviewDetail").get("data")
    log(f"\n6. review notes     {len(text)} characters from store/review-notes.txt")
    if detail and (attrs(detail).get("notes") or "").strip() == text:
        log("   already up to date — leaving alone")
    elif detail:
        # Only `notes`. The contact name, email and phone on this resource are personal
        # data that somebody typed in; this script has no business rewriting them.
        api.request("PATCH", f"/v1/appStoreReviewDetails/{detail['id']}",
                    {"data": {"type": "appStoreReviewDetails", "id": detail["id"],
                              "attributes": {"notes": text}}})
        log("   updated")
    else:
        api.request("POST", "/v1/appStoreReviewDetails", {
            "data": {"type": "appStoreReviewDetails", "attributes": {"notes": text},
                     "relationships": {"appStoreVersion": {
                         "data": {"type": "appStoreVersions", "id": vid}}}}})
        log("   created")

    # --- 7. hand over ---------------------------------------------------------------------
    # asc_submit re-reads everything from scratch and applies its own guards — the version
    # /build match, the approval gate, and the refusal to confirm a submission whose two
    # items it has not read back. Nothing here is taken on trust twice.
    log("\n7. handing over to asc_submit for the submission itself")
    log("=" * 72)
    return asc_submit.run(args.app_id, str(args.build), args.submit, True, False)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AscError as exc:
        print(f"\nasc-resubmit: {exc}", file=sys.stderr)
        sys.exit(1)
