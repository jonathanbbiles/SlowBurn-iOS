#!/usr/bin/env python3
"""
asc-inspect.py — READ-ONLY dump of everything App Store Connect knows about this app.

It exists because the two questions that decide a resubmission — "what is actually in
the open review submission?" and "what state is each in-app purchase in, and does the
listing copy contradict it?" — cannot be answered from the repo, and answering them by
clicking through App Store Connect is slow and easy to get wrong.

STRICTLY READ-ONLY. Every call is a GET. There is no write path in this file and one
must never be added: the submit path lives in scripts/asc-release.py, behind its own
gates. Run it from a Codemagic build (workflow `asc-inspect`), which is the only place
the App Store Connect key exists — see CREDENTIALS.md / asc-auth-check.sh.

    python3 scripts/asc-inspect.py <ASC_APP_ID>
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from asc_submit import Asc, AscError, Credentials, attrs, submission_kinds, version_state  # noqa: E402


def hr(title):
    print("\n" + "=" * 72)
    print(title)
    print("=" * 72, flush=True)


def show(label, value, indent=2):
    print(" " * indent + f"{label:<34} {value}", flush=True)


def safe(api, path):
    """A 404/403 on one sub-resource must not abort the whole dump — several of these
    endpoints simply do not exist for every app or every account role."""
    try:
        return api.get_all(path)
    except AscError as exc:
        print(f"  (could not read {path}: {str(exc).splitlines()[0]})", flush=True)
        return []


def safe_one(api, path):
    try:
        return (api.request("GET", path) or {}).get("data")
    except AscError as exc:
        print(f"  (could not read {path}: {str(exc).splitlines()[0]})", flush=True)
        return None


def main(app_id):
    creds = Credentials()
    missing = creds.missing()
    if missing:
        print("missing credentials: " + ", ".join(missing), file=sys.stderr)
        return 2
    api = Asc(creds, verbose=False, dry=False)   # dry only guards writes; there are none

    hr(f"APP  {app_id}")
    app = safe_one(api, f"/v1/apps/{app_id}")
    a = attrs(app)
    for k in ("name", "bundleId", "sku", "primaryLocale", "contentRightsDeclaration"):
        show(k, a.get(k))

    hr("APP STORE VERSIONS")
    versions = safe(api, f"/v1/apps/{app_id}/appStoreVersions?limit=20")
    for v in versions:
        va = attrs(v)
        show(va.get("versionString", "?"),
             f"{version_state(v):<24} created={va.get('createdDate')} id={v['id']}")
    if not versions:
        print("  none")

    # The newest version in full: its build, and every word of its listing copy. The
    # listing is where a contradiction with what Apple was told would live.
    if versions:
        v = versions[0]
        vid = v["id"]
        hr(f"VERSION {attrs(v).get('versionString')} — DETAIL  (id={vid})")
        build = safe_one(api, f"/v1/appStoreVersions/{vid}/build")
        if build:
            ba = attrs(build)
            show("build CFBundleVersion", ba.get("version"))
            show("build processingState", ba.get("processingState"))
            show("build uploadedDate", ba.get("uploadedDate"))
            pre = safe_one(api, f"/v1/builds/{build['id']}/preReleaseVersion")
            show("build CFBundleShortVersion", attrs(pre).get("version") if pre else "?")
        else:
            show("build", "NONE ATTACHED")

        sub_detail = safe_one(api, f"/v1/appStoreVersions/{vid}/appStoreReviewDetail")
        if sub_detail:
            sd = attrs(sub_detail)
            for k in ("contactFirstName", "contactLastName", "demoAccountRequired",
                      "notes"):
                show("reviewDetail." + k, json.dumps(sd.get(k))[:600])

        for loc in safe(api, f"/v1/appStoreVersions/{vid}/appStoreVersionLocalizations?limit=20"):
            la = attrs(loc)
            print(f"\n  --- localization {la.get('locale')} ---", flush=True)
            for k in ("promotionalText", "keywords", "marketingUrl", "supportUrl", "whatsNew"):
                show(k, json.dumps(la.get(k)), indent=4)
            print("    description:", flush=True)
            for line in (la.get("description") or "").splitlines():
                print("      | " + line, flush=True)

    hr("APP INFO (name / subtitle / privacy policy / age rating)")
    for info in safe(api, f"/v1/apps/{app_id}/appInfos?limit=10"):
        ia = attrs(info)
        show("appInfo state", f"{ia.get('appStoreState') or ia.get('state')}  id={info['id']}")
        for k in ("appStoreAgeRating", "brazilAgeRating", "kidsAgeBand"):
            show("  " + k, ia.get(k))
        for loc in safe(api, f"/v1/appInfos/{info['id']}/appInfoLocalizations?limit=20"):
            la = attrs(loc)
            print(f"    --- {la.get('locale')} ---", flush=True)
            for k in ("name", "subtitle", "privacyPolicyUrl", "privacyChoicesUrl"):
                show(k, json.dumps(la.get(k)), indent=6)

    hr("REVIEW SUBMISSIONS")
    subs = safe(api, f"/v1/apps/{app_id}/reviewSubmissions?limit=50")
    for s in subs:
        sa = attrs(s)
        show(s["id"], f"{sa.get('state'):<22} platform={sa.get('platform')} "
                      f"submitted={sa.get('submittedDate')}")
        try:
            kinds, items = submission_kinds(api, s["id"])
            show("  contains", f"{len(items)} item(s): {', '.join(sorted(kinds)) or 'UNRESOLVED'}")
        except AscError as exc:
            show("  contains", f"(unreadable: {str(exc).splitlines()[0]})")
    if not subs:
        print("  none")

    hr("IN-APP PURCHASES")
    iaps = safe(api, f"/v1/apps/{app_id}/inAppPurchasesV2?limit=200")
    for i in iaps:
        ia = attrs(i)
        print(flush=True)
        show("productId", ia.get("productId"))
        show("  id", i["id"])
        show("  name", ia.get("name"))
        show("  type", ia.get("inAppPurchaseType"))
        show("  state", ia.get("state"))
        show("  reviewNote", json.dumps(ia.get("reviewNote"))[:400])
        show("  familySharable", ia.get("familySharable"))
        for loc in safe(api, f"/v2/inAppPurchases/{i['id']}/inAppPurchaseLocalizations?limit=20"):
            la = attrs(loc)
            show("  loc " + str(la.get("locale")),
                 f"name={json.dumps(la.get('name'))} desc={json.dumps(la.get('description'))} "
                 f"state={la.get('state')}")
        # The three things an IAP needs before it can leave MISSING_METADATA.
        prices = safe(api, f"/v2/inAppPurchases/{i['id']}/iapPriceSchedule/manualPrices?limit=10")
        show("  price points set", len(prices))
        # to-ONE relationships: read with safe_one, not safe() — get_all would try to
        # page a single object and extend the list with its dict keys.
        shot = safe_one(api, f"/v2/inAppPurchases/{i['id']}/appStoreReviewScreenshot")
        show("  review screenshot",
             f"present ({attrs(shot).get('assetDeliveryState', {})})" if shot else "MISSING")
        avail = safe_one(api, f"/v2/inAppPurchases/{i['id']}/iapPriceSchedule")
        show("  price schedule", "present" if avail else "MISSING")
    if not iaps:
        print("  none")

    hr("DONE — nothing was written")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: asc-inspect.py <ASC_APP_ID>", file=sys.stderr)
        sys.exit(2)
    try:
        sys.exit(main(sys.argv[1]))
    except AscError as exc:
        print(f"\nasc-inspect: {exc}", file=sys.stderr)
        sys.exit(1)
