#!/usr/bin/env python3
"""
asc_submit.py — submit an App Store version for review over the RAW App Store Connect API,
with a first-time in-app purchase attached to the same submission.

WHY NOT codemagic-cli-tools / fastlane
--------------------------------------
`app-store-connect review-submissions create/confirm` can only put the appStoreVersion into
a review submission. It has no way to add an in-app purchase. That is not a cosmetic gap:

    A NEW in-app purchase must be reviewed IN THE SAME review submission as the app version
    that sells it.

Submit the version on its own and Apple reviews the app, approves it, and the IAP stays
stuck in "Ready to Submit" forever — or the review comes back asking where the purchase is.
That exact split is what got ChordLoop, Bull or Bust and Receiptless rejected. It is the
most expensive mistake in this whole pipeline because it costs a full review cycle every
time, and the tooling gives no hint that anything is missing.

The raw API can do it. A review submission is a container:

    POST /v1/reviewSubmissions                     -> an empty container
    POST /v1/reviewSubmissionItems  (appStoreVersion)   -> put the version in
    POST /v1/reviewSubmissionItems  (inAppPurchaseV2)   -> put the IAP in     <- the part
    GET  /v1/reviewSubmissions/{id}/items          -> PROVE both are in there    tools skip
    PATCH /v1/reviewSubmissions/{id} submitted=true     -> hand it to App Review

The GET between attaching and submitting is not decoration. It is the only thing standing
between "I think I attached the IAP" and another rejection, so this script refuses to
confirm a submission whose contents it has not read back and checked.

GATES — this script cannot submit anything on its own
-----------------------------------------------------
  1. --submit must be passed. Without it every call is read-only and it prints a plan.
  2. --approve <build-number> must be passed, naming the build a human tested on a real
     device, and it must match the build actually attached to the version. TestFlight
     approval is one of the only two human touchpoints in this pipeline; automating past
     it would defeat the entire design.
  3. The version record's versionString must equal the build's CFBundleShortVersionString.
     Apple lets these drift and then rejects for it.

CREDENTIALS  (never printed, never written, read from the environment only)
  ASC_KEY_ID           the App Store Connect API key id
  ASC_ISSUER_ID        the issuer id from Users and Access -> Integrations
  ASC_PRIVATE_KEY      the .p8 text, OR
  ASC_PRIVATE_KEY_PATH a path to the .p8 file
Inside Codemagic these arrive as APP_STORE_CONNECT_KEY_IDENTIFIER / _ISSUER_ID /
_PRIVATE_KEY; both spellings are accepted.
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

API_BASE = os.environ.get("ASC_API_BASE", "https://api.appstoreconnect.apple.com")
AUD = "appstoreconnect-v1"

# App Store version states that can still be put into a review submission. Anything else
# is already with Apple, already live, or already dead.
SUBMITTABLE_VERSION_STATES = {
    "PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED",
    "METADATA_REJECTED", "INVALID_BINARY",
}
# READY_FOR_REVIEW on the VERSION is not "with Apple" — it means the version is already
# staged inside a review submission that nobody has confirmed yet. That is the state a
# half-finished run leaves behind, and the only thing it needs is the final PATCH. Treating
# it as untouchable strands the submission: the version cannot be re-prepared and cannot be
# submitted, and the only way out is the browser. So it is RESUMABLE, not editable — no new
# writes are implied, just permission to finish.
RESUMABLE_VERSION_STATES = {"READY_FOR_REVIEW"}

# A review submission in one of these is OPEN: it owns the version, and a second one
# cannot be created until it is dealt with.
OPEN_SUBMISSION_STATES = {
    "READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES",
}
# An IAP in this state is waiting to be attached to a review submission. Anything already
# approved, in review, or removed must NOT be attached again.
IAP_NEEDS_REVIEW_STATES = {"READY_TO_SUBMIT"}
IAP_IN_FLIGHT_STATES = {"WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_BINARY_APPROVAL"}


class AscError(Exception):
    pass


# --------------------------------------------------------------------------- JWT (ES256)
def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _der_to_raw(der: bytes, size: int = 32) -> bytes:
    """openssl signs to DER (SEQUENCE { INTEGER r, INTEGER s }); JWS wants raw r||s, each
    left-padded to the curve size. Getting this wrong yields a token Apple rejects with a
    401 that says nothing useful, so it is done explicitly rather than hopefully."""
    if not der or der[0] != 0x30:
        raise AscError("signature is not DER — openssl did not sign the token")
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    out = b""
    for _ in range(2):
        if der[i] != 0x02:
            raise AscError("malformed DER signature")
        ln = der[i + 1]
        i += 2
        v = der[i:i + ln].lstrip(b"\x00")
        i += ln
        if len(v) > size:
            raise AscError("signature component larger than the curve")
        out += v.rjust(size, b"\x00")
    return out


class Credentials:
    def __init__(self):
        self.key_id = (os.environ.get("ASC_KEY_ID")
                       or os.environ.get("APP_STORE_CONNECT_KEY_IDENTIFIER") or "")
        self.issuer = (os.environ.get("ASC_ISSUER_ID")
                       or os.environ.get("APP_STORE_CONNECT_ISSUER_ID") or "")
        self._pem = (os.environ.get("ASC_PRIVATE_KEY")
                     or os.environ.get("APP_STORE_CONNECT_PRIVATE_KEY") or "")
        path = (os.environ.get("ASC_PRIVATE_KEY_PATH")
                or os.environ.get("APP_STORE_CONNECT_PRIVATE_KEY_PATH") or "")
        if not self._pem and path:
            with open(os.path.expanduser(path), encoding="utf-8") as fh:
                self._pem = fh.read()
        if "BEGIN" not in self._pem:
            # The key is often NOT in the environment variable. Codemagic writes the .p8 to
            # ~/.appstoreconnect/private_keys/ and its own CLI reads it from there without
            # being told — which is why `app-store-connect` authenticates in a build where
            # anything reading only the variable fails, with the same key. Look on disk too.
            for directory in (os.path.expanduser("~/.appstoreconnect/private_keys"),
                              os.path.expanduser("~/private_keys"),
                              os.path.join(os.getcwd(), "private_keys")):
                if not os.path.isdir(directory):
                    continue
                names = sorted(n for n in os.listdir(directory) if n.endswith(".p8"))
                # Prefer the file whose name carries this key id.
                names.sort(key=lambda n: 0 if self.key_id and self.key_id in n else 1)
                for name in names:
                    try:
                        with open(os.path.join(directory, name), encoding="utf-8") as fh:
                            candidate = fh.read()
                    except OSError:
                        continue
                    if "BEGIN" in candidate:
                        self._pem = candidate
                        break
                if "BEGIN" in self._pem:
                    break

    def missing(self):
        out = []
        if not self.key_id:
            out.append("ASC_KEY_ID")
        if not self.issuer:
            out.append("ASC_ISSUER_ID")
        if not self._pem:
            out.append("ASC_PRIVATE_KEY (or ASC_PRIVATE_KEY_PATH)")
        return out

    def token(self, ttl=15 * 60):
        """A fresh ES256 JWT. Apple caps the lifetime at 20 minutes; 15 leaves room for a
        slow submission without ever handing out a long-lived credential."""
        now = int(time.time())
        header = {"alg": "ES256", "kid": self.key_id, "typ": "JWT"}
        payload = {"iss": self.issuer, "iat": now, "exp": now + ttl, "aud": AUD}
        signing_input = f"{_b64u(json.dumps(header, separators=(',', ':')).encode())}." \
                        f"{_b64u(json.dumps(payload, separators=(',', ':')).encode())}"
        # The key is written to a 0600 temp file for the length of one openssl call and
        # deleted immediately. It is never passed as an argument (argv is world-readable)
        # and never logged.
        fd, path = tempfile.mkstemp(suffix=".p8")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(self._pem if self._pem.endswith("\n") else self._pem + "\n")
            proc = subprocess.run(["openssl", "dgst", "-sha256", "-sign", path],
                                  input=signing_input.encode(), capture_output=True)
            if proc.returncode != 0:
                raise AscError(
                    "openssl could not sign with this key. Check that ASC_PRIVATE_KEY holds "
                    "the WHOLE .p8 text including the BEGIN/END lines and its newlines.")
            return f"{signing_input}.{_b64u(_der_to_raw(proc.stdout))}"
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass


# ------------------------------------------------------------------------------- client
class Asc:
    def __init__(self, creds, verbose=False, dry=False):
        self.creds = creds
        self.verbose = verbose
        self.dry = dry
        self._token = None
        self._token_at = 0
        self.calls = []

    def _auth(self):
        if not self._token or time.time() - self._token_at > 10 * 60:
            self._token = self.creds.token()
            self._token_at = time.time()
        return self._token

    def request(self, method, path, body=None, allow_write=True):
        if method != "GET" and self.dry and allow_write:
            self.calls.append((method, path, body))
            log(f"    [plan] {method} {path}")
            return {}
        url = path if path.startswith("http") else API_BASE + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self._auth()}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                raw = resp.read()
                self.calls.append((method, path, None))
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise AscError(f"{method} {path} -> HTTP {exc.code}\n{_explain(exc.code, detail)}")
        except urllib.error.URLError as exc:
            raise AscError(f"{method} {path} -> network error: {exc.reason}")

    def get_all(self, path):
        """Follow paging. An app with more than one page of IAPs would otherwise silently
        submit only the ones on page one."""
        out = []
        url = path
        while url:
            doc = self.request("GET", url)
            out.extend(doc.get("data", []))
            url = (doc.get("links") or {}).get("next")
        return out


def _explain(code, detail):
    try:
        errs = json.loads(detail).get("errors", [])
        lines = [f"  {e.get('title', '')}: {e.get('detail', '')}" for e in errs]
        detail = "\n".join(lines) or detail
    except (ValueError, AttributeError):
        pass
    hints = {
        401: "  The key was rejected. Check ASC_KEY_ID / ASC_ISSUER_ID, and that the key\n"
             "  has not been revoked in Users and Access -> Integrations.",
        403: "  The key authenticated but is not allowed to do this. A submission needs\n"
             "  App Manager or Admin; Developer is not enough.",
        409: "  Apple says the resource is in the wrong state for this — most often an\n"
             "  open review submission already owns the version, or the IAP is not in\n"
             "  Ready to Submit.",
    }
    return detail + ("\n" + hints[code] if code in hints else "")


# ------------------------------------------------------------------------------ helpers
def log(msg=""):
    print(msg, flush=True)


def attrs(res):
    return (res or {}).get("attributes") or {}


def version_state(v):
    a = attrs(v)
    # Apple renamed appStoreState -> appVersionState mid-flight and both still appear
    # depending on the account. Read whichever is present rather than picking one.
    return a.get("appVersionState") or a.get("appStoreState") or "UNKNOWN"


# ------------------------------------------------------------------------------ the flow
def run(app_id, approved_build, do_submit, expect_iap, verbose):
    creds = Credentials()
    missing = creds.missing()
    if missing:
        raise AscError(
            "missing credentials: " + ", ".join(missing) + "\n"
            "  Inside Codemagic these come from `integrations: app_store_connect:`.\n"
            "  Locally, export them first — see CREDENTIALS.md.")

    api = Asc(creds, verbose=verbose, dry=not do_submit)

    log(f"== App Store review submission — app {app_id} ==")
    log(f"   mode: {'SUBMIT' if do_submit else 'PLAN ONLY (read-only; nothing will be sent)'}")

    # --- 1. the version -----------------------------------------------------------------
    versions = api.get_all(f"/v1/apps/{app_id}/appStoreVersions?limit=20")
    usable = SUBMITTABLE_VERSION_STATES | RESUMABLE_VERSION_STATES
    editable = [v for v in versions if version_state(v) in usable]
    if not editable:
        states = ", ".join(sorted({version_state(v) for v in versions})) or "none"
        raise AscError(
            f"no App Store version is in a submittable state (found: {states}).\n"
            "  A released app needs a NEW version record before it can be submitted again.")
    # A version already staged in an unconfirmed submission is the one to finish. Picking
    # any other would create a second submission beside it and neither would go anywhere.
    editable.sort(key=lambda v: 0 if version_state(v) in RESUMABLE_VERSION_STATES else 1)
    version = editable[0]
    vid = version["id"]
    vstring = attrs(version).get("versionString", "?")
    log(f"\n1. version record  {vstring}  ({version_state(version)})  id={vid}")

    # --- 2. the build behind it ----------------------------------------------------------
    build = api.request("GET", f"/v1/appStoreVersions/{vid}/build").get("data")
    if not build:
        raise AscError(
            "that version has no build attached yet.\n"
            "  Either the upload is still processing, or the build was never selected.")
    build_number = attrs(build).get("version", "?")          # CFBundleVersion
    pre = api.request("GET", f"/v1/builds/{build['id']}/preReleaseVersion").get("data")
    build_short = attrs(pre).get("version", "?")             # CFBundleShortVersionString
    log(f"2. build           {build_short} ({build_number})  id={build['id']}")

    # THE MISMATCH GATE. App Store Connect will happily let a version record called 1.1.0
    # carry a build whose CFBundleShortVersionString is 1.0.1, and then reject the
    # submission for it. Catch it here, where the fix is a one-line MARKETING_VERSION
    # change and a rebuild, not a lost review cycle.
    if build_short != "?" and build_short != vstring:
        raise AscError(
            f"VERSION MISMATCH — the version record says {vstring}, the attached build says "
            f"{build_short}.\n"
            "  Apple rejects this. Fix it in one of two ways:\n"
            f"    - set MARKETING_VERSION: \"{vstring}\" in codemagic.yaml and rebuild, or\n"
            f"    - rename the App Store version record to {build_short}.\n"
            "  Then re-run.")
    log("   version string matches the build — no mismatch")

    # --- 3. the approval gate -------------------------------------------------------------
    if approved_build is None:
        raise AscError(
            "no build has been approved.\n"
            "  This pipeline has exactly two human touchpoints and this is the second one:\n"
            "  somebody installs the TestFlight build, uses it, and says it is good.\n"
            f"  When that has happened for build {build_number}, re-run with:\n"
            f"      --approve {build_number}")
    if str(approved_build) != str(build_number):
        raise AscError(
            f"APPROVAL DOES NOT MATCH. You approved build {approved_build}, but the version "
            f"record carries build {build_number}.\n"
            "  Submitting a build nobody tested is exactly what this gate exists to stop.\n"
            f"  Either test {build_number} and approve that, or attach {approved_build} to "
            "the version first.")
    log(f"3. approval        build {approved_build} — approved by the operator")

    # --- 4. in-app purchases ---------------------------------------------------------------
    iaps = api.get_all(f"/v1/apps/{app_id}/inAppPurchasesV2?limit=200")
    needs_review = [i for i in iaps if attrs(i).get("state") in IAP_NEEDS_REVIEW_STATES]
    in_flight = [i for i in iaps if attrs(i).get("state") in IAP_IN_FLIGHT_STATES]
    log(f"4. in-app purchases  {len(iaps)} total, "
        f"{len(needs_review)} ready to submit, {len(in_flight)} already in flight")
    for i in iaps:
        log(f"     {attrs(i).get('productId', '?'):<40} {attrs(i).get('state', '?')}")

    if expect_iap and not needs_review and not in_flight:
        raise AscError(
            "--expect-iap was given but no in-app purchase is ready to submit.\n"
            "  An IAP sitting in MISSING_METADATA is not submittable: it needs its\n"
            "  localisation, price, review screenshot and review notes filled in first.\n"
            "  Fix that in App Store Connect, then re-run.")

    # --- 5. an existing open submission? ---------------------------------------------------
    subs = api.get_all(f"/v1/apps/{app_id}/reviewSubmissions?limit=50")
    open_subs = [s for s in subs if attrs(s).get("state") in OPEN_SUBMISSION_STATES]
    submission = None
    if open_subs:
        submission = open_subs[0]
        sid = submission["id"]
        kinds, items = submission_kinds(api, sid)
        log(f"\n5. an OPEN review submission already exists: {sid} "
            f"({attrs(submission).get('state')})")
        log(f"   it contains: {kinds or 'nothing'}")
        if needs_review and "inAppPurchaseV2" not in kinds:
            # The exact wrong state that cost three review cycles: a version-only
            # submission sitting open while the IAP waits beside it forever.
            log("\n   THIS IS THE VERSION-ONLY SUBMISSION PROBLEM.")
            log("   It holds the app version but not the in-app purchase, and Apple will")
            log("   not review an IAP that is not in the same submission. Items cannot be")
            log("   added to a submission that has already been handed over, so this one")
            log("   has to be cancelled and rebuilt with both parts in it.")
            if not do_submit:
                log("   [plan] would PATCH it to CANCELING, then create a new submission")
                submission = None
            else:
                log("   cancelling it…")
                api.request("PATCH", f"/v1/reviewSubmissions/{sid}",
                            {"data": {"type": "reviewSubmissions", "id": sid,
                                      "attributes": {"canceled": True}}})
                _wait_cancelled(api, app_id, sid)
                submission = None
        elif attrs(submission).get("state") != "READY_FOR_REVIEW":
            raise AscError(
                f"submission {sid} is {attrs(submission).get('state')} — it is already with "
                "Apple.\n  Nothing to do until it comes back.")

    # --- 6. create the submission ----------------------------------------------------------
    if submission is None:
        log("\n6. creating a review submission")
        doc = api.request("POST", "/v1/reviewSubmissions", {
            "data": {"type": "reviewSubmissions",
                     "attributes": {"platform": "IOS"},
                     "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}})
        submission = doc.get("data") or {"id": "(planned)"}
    sid = submission["id"]
    log(f"   submission {sid}")

    # --- 7. attach BOTH parts ---------------------------------------------------------------
    existing = submission_kinds(api, sid)[0] if sid != "(planned)" else set()

    log("\n7. attaching items")
    # What we can PROVE is in the submission. Two things count as proof: reading it back,
    # or Apple refusing to add it because it is already there. Nothing is assumed — an item
    # whose POST neither succeeded nor 409'd never enters this set.
    proven = set(existing)
    if "appStoreVersion" not in existing:
        already = _add_item(api, sid, "appStoreVersion", "appStoreVersions", vid)
        log(f"   {'=' if already else '+'} appStoreVersion {vstring}"
            + (" (Apple: already added)" if already else ""))
        proven.add("appStoreVersion")
    else:
        log(f"   = appStoreVersion {vstring} (already attached)")

    for iap in needs_review:
        already = _add_item(api, sid, "inAppPurchaseV2", "inAppPurchases", iap["id"])
        log(f"   {'=' if already else '+'} inAppPurchaseV2 {attrs(iap).get('productId')}"
            + (" (Apple: already added)" if already else ""))
        proven.add("inAppPurchaseV2")
    for iap in in_flight:
        log(f"   = inAppPurchaseV2 {attrs(iap).get('productId')} "
            f"({attrs(iap).get('state')} — already with Apple, not re-attached)")

    # --- 8. PROVE it before confirming --------------------------------------------------------
    log("\n8. verifying the submission contents before confirming")
    if not do_submit:
        log("   [plan] would GET /v1/reviewSubmissions/<id>/items and require BOTH kinds")
        log("\n== PLAN COMPLETE — nothing was submitted ==")
        log("   Re-run with --submit to carry it out.")
        return 0

    kinds, items = submission_kinds(api, sid)
    log(f"   read back: {', '.join(sorted(kinds)) or 'NOTHING'}")
    if not kinds and proven:
        # Apple's items endpoint can report an empty submission that is not empty. Do not
        # let that block a submission whose contents were proven at attach time — but say
        # so out loud, because a silent fallback here would hide a real empty submission.
        log(f"   items endpoint returned nothing; falling back to what was proven when")
        log(f"   attaching: {', '.join(sorted(proven))}")
    kinds = kinds | proven
    log(f"   submission contains: {', '.join(sorted(kinds)) or 'NOTHING'}")
    if "appStoreVersion" not in kinds:
        raise AscError("the app version is NOT in the submission. Refusing to confirm.")
    want_iap = bool(needs_review) or expect_iap
    if want_iap and "inAppPurchaseV2" not in kinds:
        raise AscError(
            "the in-app purchase is NOT in the submission. Refusing to confirm.\n"
            "  Confirming now would submit the version alone — the exact split that got\n"
            "  ChordLoop, Bull or Bust and Receiptless rejected. Nothing has been sent to\n"
            "  Apple; fix the IAP's state and re-run.")
    log("   both required items are present")

    # --- 9. hand it to App Review ---------------------------------------------------------------
    log("\n9. submitting for review")
    api.request("PATCH", f"/v1/reviewSubmissions/{sid}",
                {"data": {"type": "reviewSubmissions", "id": sid,
                          "attributes": {"submitted": True}}})
    final = api.request("GET", f"/v1/reviewSubmissions/{sid}").get("data")
    log(f"\n== SUBMITTED ==  state: {attrs(final).get('state')}")
    log(f"   version {vstring} (build {build_number})"
        + (f" + {len(needs_review)} in-app purchase(s)" if needs_review else ""))
    return 0


REL_KINDS = ("appStoreVersion", "inAppPurchaseV2", "appEvent",
             "appCustomProductPageVersion", "appStoreVersionExperiment")


def _kinds(items):
    """Which kinds of thing are in a submission. The relationship NAME is what matters:
    an item's own type is always reviewSubmissionItems."""
    out = set()
    for it in items:
        for rel in REL_KINDS:
            if ((it.get("relationships") or {}).get(rel) or {}).get("data"):
                out.add(rel)
    return out


def submission_kinds(api, sid):
    """What is ACTUALLY in a submission — resolved, not assumed.

    ⚠️ Do not go back to a plain `GET /items` + `_kinds`. Apple does not inline
    relationship `data` on reviewSubmissionItems unless the relationship is explicitly
    included, so a plain read reports an EMPTY submission even when the items are sitting
    right there. That is not a harmless quirk: it makes step 8 refuse to confirm a perfectly
    good submission with "the app version is NOT in the submission", which reads as a
    missing item and sends you looking in App Store Connect for a problem that isn't there.
    Cost one Tassel 1.3.1 submission run to find.

    Two passes, because an `include` list Apple dislikes is a 400 rather than a partial
    answer: ask for the includes first, then fall back to following each relationship's own
    `links.related` URL. The fallback is Apple's own link, so it cannot drift.
    """
    items = []
    try:
        items = api.get_all(f"/v1/reviewSubmissions/{sid}/items"
                            f"?include=appStoreVersion,inAppPurchaseV2&limit=50")
        kinds = _kinds(items)
        if kinds:
            return kinds, items
    except AscError:
        pass

    if not items:
        items = api.get_all(f"/v1/reviewSubmissions/{sid}/items?limit=50")
    kinds = _kinds(items)
    if kinds or not items:
        return kinds, items

    for it in items:
        rels = it.get("relationships") or {}
        for rel in REL_KINDS:
            relobj = rels.get(rel) or {}
            if relobj.get("data"):
                kinds.add(rel)
                continue
            related = (relobj.get("links") or {}).get("related")
            if not related:
                continue
            try:
                if (api.request("GET", related) or {}).get("data"):
                    kinds.add(rel)
            except AscError:
                continue
    return kinds, items


def _add_item(api, sid, rel_name, rel_type, rel_id):
    """Put one thing into the submission. Returns True if Apple says it was ALREADY there.

    A 409 "was already added to this reviewSubmission" is not a failure — it is Apple
    stating, authoritatively, that the item is in the submission. That matters because
    `GET /items` has been observed returning an EMPTY list for a submission that demonstrably
    contains the version (Tassel 1.3.1: the read said nothing, the POST said "already
    added"). Treating the 409 as fatal turns Apple confirming the thing we wanted into a
    build failure."""
    try:
        api.request("POST", "/v1/reviewSubmissionItems", {
            "data": {"type": "reviewSubmissionItems",
                     "relationships": {
                         "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sid}},
                         rel_name: {"data": {"type": rel_type, "id": rel_id}}}}})
        return False
    except AscError as exc:
        if "already added" in str(exc).lower():
            return True
        raise


def _wait_cancelled(api, app_id, sid, tries=10):
    """Apple does not free the version the instant the PATCH returns. Creating the
    replacement submission too early fails with a 409 that reads like a different bug."""
    for _ in range(tries):
        time.sleep(3)
        subs = api.get_all(f"/v1/apps/{app_id}/reviewSubmissions?limit=50")
        cur = next((s for s in subs if s["id"] == sid), None)
        if cur is None or attrs(cur).get("state") not in OPEN_SUBMISSION_STATES:
            log("   cancelled")
            return
    raise AscError(f"submission {sid} did not leave its open state after cancelling.")


def main(argv):
    app_id = None
    approved = None
    do_submit = False
    expect_iap = False
    verbose = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--approve":
            approved = argv[i + 1]; i += 2
        elif a == "--submit":
            do_submit = True; i += 1
        elif a == "--expect-iap":
            expect_iap = True; i += 1
        elif a in ("-v", "--verbose"):
            verbose = True; i += 1
        elif a in ("-h", "--help"):
            print(__doc__); return 0
        else:
            app_id = a; i += 1
    if not app_id:
        print("usage: asc_submit.py <ASC_APP_ID> [--approve <build>] [--submit] [--expect-iap]",
              file=sys.stderr)
        return 2
    if not re.fullmatch(r"\d+", str(app_id)):
        print(f"asc_submit: '{app_id}' is not an App Store Connect app id (it is numeric)",
              file=sys.stderr)
        return 2
    try:
        return run(app_id, approved, do_submit, expect_iap, verbose)
    except AscError as exc:
        print(f"\nasc-submit: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
