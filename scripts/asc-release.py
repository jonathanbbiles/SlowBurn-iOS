#!/usr/bin/env python3
"""
asc-release.py — prepare an App Store version and hand it to App Review, headless.

WHY THIS EXISTS ALONGSIDE asc_submit.py
---------------------------------------
`scripts/lib/asc_submit.py` (vendored from app-factory) submits a version that is ALREADY
prepared: it insists on finding an editable version with a build attached, then builds the
reviewSubmission and confirms it. Everything before that — creating the version record,
writing "What's New", choosing the build — was still a browser job.

This script is that missing first half, and then it delegates. Three steps, each idempotent,
followed by the proven submit flow:

    1. find or create the App Store version record   (POST /v1/appStoreVersions)
    2. write What's New into every localisation      (PATCH appStoreVersionLocalizations)
    3. attach the approved build                     (PATCH .../relationships/build)
    -> asc_submit.run(...)                           (the guards + the actual submission)

WHERE IT RUNS
-------------
Inside Codemagic, on an app whose workflow declares `integrations: app_store_connect:`.
It CANNOT run on the Mac: the .p8 lives on the Codemagic build machine, never here — see
CREDENTIALS in asc_submit.py. That is also why the whole thing is a workflow rather than a
laptop script.

SAFETY
------
- PLAN by default. Nothing is written without --submit. `--plan` prints exactly what would
  change, including the version state and the build it would attach.
- It refuses to touch a version that is already with Apple: only the states asc_submit.py
  calls submittable are editable, and an unreadable state counts as "no".
- The build it attaches must match --build exactly, and asc_submit's own mismatch gate then
  re-checks CFBundleShortVersionString against the version string. A build nobody approved
  cannot slip in, because --build is also what gets passed as --approve.
- "Keep other metadata as-is" is literal: it writes ONLY whatsNew. Description, keywords,
  screenshots, support URL, age rating and pricing are never touched.

USAGE
    python3 scripts/asc-release.py --app-id 6789951155 --version 1.3.1 \
        --build 202608152155 --whats-new-file release-notes/1.3.1.txt [--submit]
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))

import asc_submit  # noqa: E402
from asc_submit import Asc, AscError, Credentials, attrs, log, version_state  # noqa: E402


# Fields copied forward when a version record has NO localisations of its own and one has to
# be built from the previous version. whatsNew is deliberately absent — it is the one field
# this script owns. `description` and `name` are required by Apple on create.
COPY_FIELDS = ("description", "keywords", "marketingUrl", "promotionalText",
               "supportUrl", "name", "subtitle")


def find_version(api, app_id, version_string):
    """The version record for this release, if it exists at all — in ANY state, because a
    version sitting in WAITING_FOR_REVIEW has to be reported as such rather than silently
    skipped and re-created."""
    versions = api.get_all(f"/v1/apps/{app_id}/appStoreVersions?limit=50")
    for v in versions:
        if attrs(v).get("versionString") == version_string:
            return v, versions
    return None, versions


def ensure_version(api, app_id, version_string, do_write):
    version, all_versions = find_version(api, app_id, version_string)

    if version is not None:
        state = version_state(version)
        log(f"1. version record  {version_string}  ({state})  id={version['id']}")
        if state in asc_submit.RESUMABLE_VERSION_STATES:
            # Already staged inside an unconfirmed review submission — the state a
            # half-finished run leaves behind. Nothing to prepare; steps 2 and 3 will find
            # their work already done and the submit flow finishes it. Refusing here was
            # what stranded Tassel 1.3.1 between "created" and "submitted".
            log("   already staged in an open submission — resuming, not re-preparing")
            return version
        if state not in asc_submit.SUBMITTABLE_VERSION_STATES:
            raise AscError(
                f"version {version_string} exists but is {state} — it is not editable.\n"
                "  If it is already with Apple there is nothing to do; if it was released,\n"
                "  a NEW version number is needed.")
        return version

    live = ", ".join(f"{attrs(v).get('versionString')} ({version_state(v)})"
                     for v in all_versions[:5]) or "none"
    log(f"1. version record  {version_string} does not exist yet — creating it")
    log(f"   existing versions: {live}")
    if not do_write:
        log("   [plan] would POST /v1/appStoreVersions")
        return None

    doc = api.request("POST", "/v1/appStoreVersions", {
        "data": {
            "type": "appStoreVersions",
            "attributes": {"platform": "IOS", "versionString": version_string},
            "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
        }})
    version = doc.get("data")
    if not version:
        raise AscError("App Store Connect accepted the create but returned no version.")
    log(f"   created  id={version['id']}")
    return version


def set_whats_new(api, version, all_versions, text, do_write):
    """Write whatsNew, and ONLY whatsNew.

    A version created through the API normally inherits the previous version's localisations,
    but that is Apple's behaviour rather than a promise. If it did not, this builds the
    en-US localisation by copying the previous version's fields forward — otherwise the
    submission would fail later on a missing description, which reads as a mystery."""
    vid = version["id"]
    locs = api.get_all(f"/v1/appStoreVersions/{vid}/appStoreVersionLocalizations?limit=50")

    if not locs:
        log("2. what's new      no localisations on this version — copying the previous one")
        prev = next((v for v in all_versions if v["id"] != vid), None)
        source = {}
        if prev:
            prev_locs = api.get_all(
                f"/v1/appStoreVersions/{prev['id']}/appStoreVersionLocalizations?limit=50")
            if prev_locs:
                source = attrs(prev_locs[0])
        if not do_write:
            log("   [plan] would POST an en-US localisation carrying the previous copy")
            return
        body_attrs = {k: source[k] for k in COPY_FIELDS if source.get(k)}
        body_attrs["locale"] = source.get("locale") or "en-US"
        body_attrs["whatsNew"] = text
        api.request("POST", "/v1/appStoreVersionLocalizations", {
            "data": {"type": "appStoreVersionLocalizations",
                     "attributes": body_attrs,
                     "relationships": {"appStoreVersion": {
                         "data": {"type": "appStoreVersions", "id": vid}}}}})
        log(f"   created {body_attrs['locale']} with the release notes")
        return

    log(f"2. what's new      {len(locs)} localisation(s)")
    for loc in locs:
        locale = attrs(loc).get("locale", "?")
        current = (attrs(loc).get("whatsNew") or "").strip()
        if current == text.strip():
            log(f"   = {locale} already has these notes")
            continue
        if not do_write:
            log(f"   [plan] would PATCH {locale} whatsNew ({len(text)} chars)")
            continue
        api.request("PATCH", f"/v1/appStoreVersionLocalizations/{loc['id']}", {
            "data": {"type": "appStoreVersionLocalizations", "id": loc["id"],
                     "attributes": {"whatsNew": text}}})
        log(f"   + {locale} release notes written")


def attach_build(api, app_id, version, build_number, do_write):
    """Point the version at the build we actually tested.

    Looked up by CFBundleVersion rather than 'the newest build', because 'newest' is exactly
    how an untested binary ends up in front of Apple."""
    vid = version["id"]
    current = api.request("GET", f"/v1/appStoreVersions/{vid}/build").get("data")
    if current and attrs(current).get("version") == str(build_number):
        log(f"3. build           {build_number} already attached  id={current['id']}")
        return

    builds = api.get_all(
        f"/v1/builds?filter[app]={app_id}&filter[version]={build_number}&limit=10")
    if not builds:
        raise AscError(
            f"no build numbered {build_number} exists for this app.\n"
            "  Either it is still processing, or the number is wrong. TestFlight shows the\n"
            "  build numbers Apple actually accepted.")
    build = builds[0]
    state = attrs(build).get("processingState")
    log(f"3. build           {build_number}  id={build['id']}  processing={state}")
    if state != "VALID":
        raise AscError(
            f"build {build_number} is {state}, not VALID — it cannot be attached yet.\n"
            "  PROCESSING means wait; INVALID or FAILED means it has to be rebuilt.")
    if current:
        log(f"   replacing currently attached build {attrs(current).get('version')}")
    if not do_write:
        log("   [plan] would PATCH the version's build relationship")
        return
    api.request("PATCH", f"/v1/appStoreVersions/{vid}/relationships/build", {
        "data": {"type": "builds", "id": build["id"]}})
    log("   attached")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Prepare an App Store version and submit it.")
    ap.add_argument("--app-id", required=True)
    ap.add_argument("--version", required=True, help="version string, e.g. 1.3.1")
    ap.add_argument("--build", required=True, help="CFBundleVersion of the approved build")
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--whats-new", help="release notes text")
    group.add_argument("--whats-new-file", help="file holding the release notes")
    ap.add_argument("--submit", action="store_true",
                    help="actually write and submit (default is plan only)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    if args.whats_new_file:
        with open(args.whats_new_file, encoding="utf-8") as fh:
            whats_new = fh.read().strip()
    else:
        whats_new = (args.whats_new or "").strip()
    if not whats_new:
        raise AscError("no release notes given — pass --whats-new or --whats-new-file.")
    if len(whats_new) > 4000:
        raise AscError(f"release notes are {len(whats_new)} characters; Apple's limit is 4000.")

    creds = Credentials()
    missing = creds.missing()
    if missing:
        raise AscError(
            "missing credentials: " + ", ".join(missing) + "\n"
            "  These come from `integrations: app_store_connect:` inside Codemagic.\n"
            "  This script cannot run on a laptop — the .p8 is not there.")

    api = Asc(creds, verbose=args.verbose, dry=not args.submit)

    log(f"== Prepare {args.version} (build {args.build}) — app {args.app_id} ==")
    log(f"   mode: {'WRITE + SUBMIT' if args.submit else 'PLAN ONLY (nothing is written)'}\n")

    version = ensure_version(api, args.app_id, args.version, args.submit)
    if version is None:
        # Plan mode, version does not exist yet: everything downstream needs its id, so
        # describe the rest rather than inventing one.
        log("\n[plan] the version does not exist yet, so what's new / build attach / submit")
        log("       cannot be planned in detail. Re-run with --submit to carry it out.")
        return 0

    _, all_versions = find_version(api, args.app_id, args.version)
    set_whats_new(api, version, all_versions, whats_new, args.submit)
    attach_build(api, args.app_id, version, args.build, args.submit)

    log("\n-- handing over to the submit flow --\n")
    # --approve is the build number: asc_submit refuses to submit a version whose attached
    # build is not the one an operator signed off. Jonathan approved this build.
    return asc_submit.run(args.app_id, args.build, args.submit, False, args.verbose)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AscError as exc:
        print(f"\nasc-release: {exc}", file=sys.stderr)
        sys.exit(1)
