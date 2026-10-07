#!/usr/bin/env python3
"""release.py — the `release` lane: ship a TestFlight build to App Review, driven by a
committed release.json. Runs INSIDE CODEMAGIC, where the `app_store_connect` integration
supplies the key. A Claude session never runs this against Apple with write access; it
commits release.json and Codemagic does the rest (GitHub is the control panel).

    python3 scripts/release.py [release.json]

release.json (committed at the repo root; committing it IS the "ship"):

    {
      "version": "2.1",                 # the ASC version string, exactly (CFBundleShortVersionString)
      "build": "202609231200",          # the 12-digit build that was tap-tested on a device
      "submit": true,                   # false = do every write, stop before submitted:true
      "iaps": ["6797705239"],           # IAP ids or product ids that ride with this version
      "screenshots": true,              # replace the iPhone 6.9" set from store/screenshots
      "whatsNew": "…",                  # or omit and keep release-notes/<version>.txt
      "copy": "store/listing-2.1.json", # optional: description / keywords / promotionalText / subtitle
      "reviewNotes": "store/review-notes-2.1.txt",  # optional: App Review Information → Notes
      "keepCopy": true,                 # optional: write no listing text (a resubmission, or a
                                        # 1.0, where Apple refuses What's New)
      "releaseType": "AFTER_APPROVAL",  # optional: MANUAL | AFTER_APPROVAL
      "iapPrices": {"6797705239": "19.99"}, # optional: USD price per IAP (id or product id)
      "iapCopy": {"6797705239": {"name": "Receiptless Tax Pro", "description": "...",
                  "reviewNote": "...", "reviewScreenshot": "store/iap-review.png"}}
                                        # optional: the IAP's en-US name/description, its
                                        # review note and App Review screenshot. An approved
                                        # IAP whose copy changes goes back to review with
                                        # this version (step 7 submits it).
    }

ONLY=prices runs just the price step (release json then needs only "iapPrices"): the
way to reprice an IAP from a commit without touching the version or a submission.

Steps, in order. Each one hard-fails (exit 1) with Apple's own error text, including
errors[].meta.associatedErrors, which is where ASC names the real blocker:

    1. build   exists, processingState == VALID, not expired, carries `version`
    2. version found or created (versionString exactly `version`); a version that is already
               with Apple or live makes the lane a no-op, so a stray re-run cannot resubmit
    3. attach  the build to the version
    4. copy    What's New (+ description/keywords/promo when `copy` is given), limits checked
    5. shots   delete-then-upload each display set, wait for Apple to finish processing
    6. submission  reuse the draft reviewSubmission or create one; add the version item
    7. IAPs    POST /v1/inAppPurchaseSubmissions for each IAP that still needs review
    8. read back the submission's items; PATCH submitted:true ONLY if the count is
               1 + (IAPs submitted for review), and only when `submit` is true

The ordering of 7 and 8 is the 2.1(b) guard: an app version submitted without the IAP it
sells is rejected, and ASC accepts such a submission silently. `scripts/verify-release.js`
drives this file against a fake App Store Connect and fails the gate if `submitted:true`
can ever be sent before the item count has been read back and matched.

Environment: ASC_APP_ID, or BUNDLE_ID to look the app up by bundle ID. Credentials: ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY
or the APP_STORE_CONNECT_* names Codemagic exports, or a .p8 in ~/.appstoreconnect/private_keys.
DRY_RUN=1 performs every read and prints every write it would make, writing nothing.
No key material is ever printed.
"""
import base64
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get('ASC_API_BASE', 'https://api.appstoreconnect.apple.com')
# The fake-ASC gate points API at localhost; nowhere else may override the host.
if not re.match(r'^(https://api\.appstoreconnect\.apple\.com|http://127\.0\.0\.1:\d+)$', API):
    sys.exit('ASC_API_BASE must be App Store Connect or 127.0.0.1 (the offline gate)')

DRY = os.environ.get('DRY_RUN', '').strip().lower() in ('1', 'true', 'yes')
ONLY = os.environ.get('ONLY', '').strip().lower()
EDITABLE = ('PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED',
            'METADATA_REJECTED', 'INVALID_BINARY',
            'READY_FOR_REVIEW')   # in an unsent draft submission — a re-run resumes it
WITH_APPLE = ('WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE',
              'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_APP_STORE', 'READY_FOR_SALE',
              'READY_FOR_DISTRIBUTION', 'ACCEPTED')
IAP_DONE = ('APPROVED',)                                   # nothing to review
IAP_QUEUED = ('WAITING_FOR_REVIEW', 'IN_REVIEW')           # already submitted
IAP_SUBMITTABLE = ('READY_TO_SUBMIT', 'DEVELOPER_ACTION_NEEDED', 'REJECTED')
LIMITS = {'whatsNew': 4000, 'description': 4000, 'keywords': 100, 'promotionalText': 170,
          'subtitle': 30}
# Display type -> filename patterns under store/screenshots, first match wins.
# APP_IPHONE_67 is the top of Apple's enum (the 6.9" set); 6.5" inherits from it.
SHOT_SETS = {'APP_IPHONE_67': ['6.9in-*.png', 'iphone69_*.png', 'iphone69-*.png'],
             'APP_IPHONE_65': ['6.5in-*.png', 'iphone65_*.png']}
SHOT_REQUIRED = ('APP_IPHONE_67',)          # the 6.5" set is replaced only when files for it exist
IAP_LIMITS = {'name': 30, 'description': 55, 'reviewNote': 4000}


# ─────────────────────────────────────────────────────────────── credentials ──
def _b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def _der_to_raw(der, size=32):
    """openssl signs to DER; a JWS wants raw r||s, each padded to the curve size."""
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    out = b''
    for _ in range(2):
        ln = der[i + 1]
        v = der[i + 2:i + 2 + ln].lstrip(b'\x00')
        i += 2 + ln
        out += v.rjust(size, b'\x00')
    return out


def _read_key(kid):
    pem = os.environ.get('ASC_PRIVATE_KEY') or os.environ.get('APP_STORE_CONNECT_PRIVATE_KEY') or ''
    if 'BEGIN' in pem:
        return pem
    b64 = os.environ.get('ASC_PRIVATE_KEY_B64', '')
    if b64:
        try:
            pem = base64.b64decode(b64).decode()
        except Exception:                                    # noqa: BLE001
            pem = ''
        if 'BEGIN' in pem:
            return pem
    files = glob.glob(os.path.expanduser('~/.appstoreconnect/private_keys/*.p8'))
    files.sort(key=lambda f: 0 if kid and kid in os.path.basename(f) else 1)
    for f in files:
        with open(f, encoding='utf-8') as fh:
            pem = fh.read()
        if 'BEGIN' in pem:
            return pem
    return ''


def token():
    if API.startswith('http://127.0.0.1'):
        return 'offline-gate'
    kid = os.environ.get('ASC_KEY_ID') or os.environ.get('APP_STORE_CONNECT_KEY_IDENTIFIER') or ''
    iss = os.environ.get('ASC_ISSUER_ID') or os.environ.get('APP_STORE_CONNECT_ISSUER_ID') or ''
    pem = _read_key(kid)
    if not (kid and iss and pem):
        sys.exit('ASC credentials missing (key id %s, issuer %s, key %s). This lane runs in '
                 'Codemagic with integrations: app_store_connect.' % (bool(kid), bool(iss), bool(pem)))
    claims = {'iss': iss, 'iat': int(time.time()), 'exp': int(time.time()) + 900,
              'aud': 'appstoreconnect-v1'}
    try:
        import jwt  # codemagic-cli-tools' interpreter has PyJWT
        return jwt.encode(claims, pem, algorithm='ES256', headers={'kid': kid, 'typ': 'JWT'})
    except BaseException:  # noqa: BLE001 — a broken cryptography build panics, not ImportError
        pass
    signing_input = '%s.%s' % (
        _b64u(json.dumps({'alg': 'ES256', 'kid': kid, 'typ': 'JWT'}, separators=(',', ':')).encode()),
        _b64u(json.dumps(claims, separators=(',', ':')).encode()))
    fd, kpath = tempfile.mkstemp(suffix='.p8')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as fh:
            fh.write(pem if pem.endswith('\n') else pem + '\n')
        proc = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', kpath],
                              input=signing_input.encode(), capture_output=True)
        if proc.returncode != 0:
            sys.exit('openssl could not sign with the App Store Connect key')
        return '%s.%s' % (signing_input, _b64u(_der_to_raw(proc.stdout)))
    finally:
        os.unlink(kpath)


TOK = None


def req(method, path, payload=None):
    """(status, body). Never raises on an HTTP status."""
    global TOK
    if TOK is None:
        TOK = token()
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(API + path, data=data, method=method,
                               headers={'Authorization': 'Bearer ' + TOK,
                                        'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read().decode('utf-8', 'replace')
            return resp.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {'raw': raw[:800]}
    except Exception as e:                                   # noqa: BLE001
        return 0, {'error': str(e)}


def write(method, path, payload, label):
    """Every write goes through here, so DRY_RUN cannot leak one."""
    if DRY:
        print('  [dry run] would %s %s  (%s)' % (method, path, label))
        return 200, {'data': {'id': 'dry-run', 'attributes': {}}}
    return req(method, path, payload)


# ─────────────────────────────────────────────────────────────────── output ──
def explain(body):
    """Every error line Apple sent, associatedErrors included — the part that names the
    missing copyright, price schedule, unpublished privacy answers, export compliance."""
    lines = []
    for e in (body.get('errors') or []):
        lines.append('%s %s: %s' % (e.get('code', ''), e.get('title', ''), e.get('detail', '')))
        assoc = ((e.get('meta') or {}).get('associatedErrors') or {})
        for where, errs in assoc.items():
            for a in errs or []:
                lines.append('   ↳ %s — %s: %s' % (where, a.get('code', ''), a.get('detail') or a.get('title', '')))
    if not lines:
        lines.append(json.dumps(body)[:800])
    return lines


def fail(step, msg, st=None, body=None):
    print('\n✗ %s: %s%s' % (step, msg, ' (HTTP %s)' % st if st is not None else ''))
    for line in explain(body or {}) if body is not None else []:
        print('   ' + line)
    STATUS.update(result='failed', step=step, reason=msg)
    dump_status()
    sys.exit(1)


def good(st):
    return st in (200, 201, 204)


STATUS = {}


def dump_status():
    try:
        with open('release-status.json', 'w', encoding='utf-8') as fh:
            json.dump(STATUS, fh, indent=2)
    except OSError:
        pass


# ──────────────────────────────────────────────────────────────────── steps ──
def load_release(path):
    try:
        with open(path, encoding='utf-8') as fh:
            rel = json.load(fh)
    except (OSError, ValueError) as e:
        fail('release.json', 'cannot read %s: %s' % (path, e))
    prices = rel.get('iapPrices') or {}
    if not isinstance(prices, dict) or not all(re.match(r'^\d{1,4}\.\d{2}$', str(v)) for v in prices.values()):
        fail('release.json', '"iapPrices" must map an IAP to a USD price like "19.99"')
    rel['iapPrices'] = {str(k): str(v) for k, v in prices.items()}
    copy_ = rel.get('iapCopy') or {}
    if not isinstance(copy_, dict) or not all(isinstance(v, dict) for v in copy_.values()):
        fail('release.json', '"iapCopy" must map an IAP to {name, description, reviewNote, reviewScreenshot}')
    for k, v in copy_.items():
        for f, val in v.items():
            if f == 'reviewScreenshot':
                if not os.path.exists(str(val)):
                    fail('release.json', 'iapCopy %s reviewScreenshot %s does not exist' % (k, val))
            elif f not in IAP_LIMITS:
                fail('release.json', 'iapCopy field %r is not one this lane writes' % f)
            elif len(str(val)) > IAP_LIMITS[f]:
                fail('release.json', 'iapCopy %s %s is %d characters; Apple allows %d' % (k, f, len(str(val)), IAP_LIMITS[f]))
    rel['iapCopy'] = {str(k): v for k, v in copy_.items()}
    if ONLY == 'prices':
        if not rel['iapPrices']:
            fail('release.json', 'ONLY=prices needs "iapPrices"')
        rel.setdefault('version', '-'); rel.setdefault('build', '-')
        return rel
    version, build = str(rel.get('version', '')).strip(), str(rel.get('build', '')).strip()
    if not re.match(r'^\d+(\.\d+){1,2}$', version):
        fail('release.json', 'version %r is not an ASC version string like 2.1' % version)
    if not re.match(r'^\d{12}$', build):
        fail('release.json', 'build %r is not the 12-digit TestFlight build number' % build)
    if not isinstance(rel.get('keepCopy', False), bool):
        fail('release.json', '"keepCopy" must be true or false')
    if not isinstance(rel.get('submit', False), bool):
        fail('release.json', '"submit" must be true or false')
    rel['version'], rel['build'] = version, build
    rel['iaps'] = [str(i) for i in (rel.get('iaps') or [])]
    wn = rel.get('whatsNew')
    if not wn:
        f = 'release-notes/%s.txt' % version
        wn = open(f, encoding='utf-8').read().strip() if os.path.exists(f) else ''
    rel['whatsNew'] = (wn or '').strip()
    copy = rel.get('copy')
    if isinstance(copy, str):
        try:
            with open(copy, encoding='utf-8') as fh:
                copy = json.load(fh)
        except (OSError, ValueError) as e:
            fail('release.json', 'copy file %s: %s' % (rel.get('copy'), e))
    rel['copy'] = copy or {}
    rn = rel.get('reviewNotes')
    if rn:
        try:
            rel['reviewNotes'] = open(rn, encoding='utf-8').read().strip()
        except OSError as e:
            fail('release.json', 'reviewNotes file %s: %s' % (rn, e))
        if len(rel['reviewNotes']) > 4000:
            fail('release.json', 'review notes are %d characters; Apple allows 4000' % len(rel['reviewNotes']))
    else:
        rel['reviewNotes'] = ''
    for k, v in list(rel['copy'].items()):
        if k not in LIMITS or k == 'whatsNew':
            fail('release.json', 'copy field %r is not one this lane writes' % k)
    for k, v in [('whatsNew', rel['whatsNew'])] + list(rel['copy'].items()):
        if len(v) > LIMITS[k]:
            fail('release.json', '%s is %d characters; Apple allows %d' % (k, len(v), LIMITS[k]))
    return rel


def step_build(app, rel):
    print('=== 1. build %s' % rel['build'])
    st, d = req('GET', '/v1/builds?filter[app]=%s&filter[version]=%s&include=preReleaseVersion'
                       '&limit=5' % (app, rel['build']))
    if not good(st):
        fail('build', 'cannot list builds', st, d)
    rows = d.get('data') or []
    if not rows:
        fail('build', 'no build %s under app %s — did the TestFlight build land?' % (rel['build'], app))
    b = rows[0]
    a = b.get('attributes') or {}
    inc = {(i['type'], i['id']): i for i in d.get('included') or []}
    pr = ((b.get('relationships') or {}).get('preReleaseVersion') or {}).get('data') or {}
    carried = ((inc.get((pr.get('type'), pr.get('id'))) or {}).get('attributes') or {}).get('version')
    print('  processingState=%s expired=%s marketing version=%s' % (
        a.get('processingState'), a.get('expired'), carried))
    if a.get('processingState') != 'VALID':
        fail('build', 'build is %s, not VALID' % a.get('processingState'))
    if a.get('expired'):
        fail('build', 'build has expired')
    if carried and carried != rel['version']:
        fail('build', 'build carries version %s, release.json says %s (CFBundleShortVersionString '
                      'must equal the ASC version string exactly)' % (carried, rel['version']))
    return b['id']


def step_version(app, rel):
    print('=== 2. version %s' % rel['version'])
    st, d = req('GET', '/v1/apps/%s/appStoreVersions?filter[platform]=IOS&limit=20' % app)
    if not good(st):
        fail('version', 'cannot list versions', st, d)
    for v in d.get('data') or []:
        a = v.get('attributes') or {}
        if a.get('versionString') != rel['version']:
            continue
        state = a.get('appStoreState') or a.get('appVersionState')
        print('  exists: %s (%s)' % (v['id'], state))
        if state in WITH_APPLE:
            print('\n✓ %s is already %s — nothing to do. (A re-run of this lane never resubmits.)'
                  % (rel['version'], state))
            STATUS.update(result='noop', state=state)
            dump_status()
            sys.exit(0)
        if state not in EDITABLE:
            fail('version', '%s is %s, which cannot take a build' % (rel['version'], state))
        return v['id']
    body = {'data': {'type': 'appStoreVersions',
                     'attributes': {'platform': 'IOS', 'versionString': rel['version'],
                                    'releaseType': rel.get('releaseType') or 'AFTER_APPROVAL'},
                     'relationships': {'app': {'data': {'type': 'apps', 'id': str(app)}}}}}
    st, d = write('POST', '/v1/appStoreVersions', body, 'create version')
    if not good(st):
        fail('version', 'could not create %s' % rel['version'], st, d)
    print('  created %s' % d['data']['id'])
    return d['data']['id']


def step_attach(vid, bid, rel):
    print('=== 3. attach build')
    if vid != 'dry-run':
        st, d = req('GET', '/v1/appStoreVersions/%s/build' % vid)
        if good(st) and ((d.get('data') or {}).get('id') == bid):
            print('  build %s is already attached' % rel['build'])
            return
    st, d = write('PATCH', '/v1/appStoreVersions/%s/relationships/build' % vid,
                  {'data': {'type': 'builds', 'id': bid}}, 'attach build %s' % rel['build'])
    if not good(st):
        fail('attach', 'could not attach build %s' % rel['build'], st, d)
    print('  attached %s' % rel['build'])


def localization(vid):
    if vid == 'dry-run':
        return {'id': 'dry-run', 'attributes': {}}
    st, d = req('GET', '/v1/appStoreVersions/%s/appStoreVersionLocalizations' % vid)
    if not good(st):
        fail('copy', 'cannot read localizations', st, d)
    for loc in d.get('data') or []:
        if (loc.get('attributes') or {}).get('locale') == 'en-US':
            return loc
    fail('copy', 'the version has no en-US localization')


def step_copy(app, vid, rel):
    print('=== 4. copy')
    if rel.get('keepCopy'):
        # A resubmission of the same version, or an app's FIRST version (Apple refuses
        # What's New on a 1.0): the listing is already right, so write nothing.
        print('  keepCopy: the listing text stays as it is')
        return
    if not rel['whatsNew']:
        fail('copy', "no What's New: set release.json whatsNew or release-notes/%s.txt" % rel['version'])
    loc = localization(vid)
    attrs = {'whatsNew': rel['whatsNew']}
    attrs.update({k: v for k, v in rel['copy'].items() if k != 'subtitle'})
    print("  what's new: %d chars; also writing %s" % (
        len(rel['whatsNew']), ', '.join(sorted(k for k in attrs if k != 'whatsNew')) or 'nothing else'))
    st, d = write('PATCH', '/v1/appStoreVersionLocalizations/%s' % loc['id'],
                  {'data': {'type': 'appStoreVersionLocalizations', 'id': loc['id'],
                            'attributes': attrs}}, 'version copy')
    if not good(st):
        fail('copy', 'version localization refused', st, d)
    if rel['reviewNotes']:
        # App Review Information lives on the version; a new version inherits the last one's,
        # which is exactly the stale text this replaces.
        if vid == 'dry-run':
            print('  [dry run] would write the App Review notes (%d chars)' % len(rel['reviewNotes']))
        else:
            st, d = req('GET', '/v1/appStoreVersions/%s/appStoreReviewDetail' % vid)
            det = (d.get('data') or None) if good(st) else None
            if not det:
                fail('copy', 'version has no App Review Information yet (contact details are set once in App Store Connect)', st, d)
            if ((det.get('attributes') or {}).get('notes') or '').strip() == rel['reviewNotes']:
                print('  App Review notes already current')
            else:
                st, d = write('PATCH', '/v1/appStoreReviewDetails/%s' % det['id'], {'data': {
                    'type': 'appStoreReviewDetails', 'id': det['id'], 'attributes': {'notes': rel['reviewNotes']}}},
                    'App Review notes')
                if not good(st):
                    fail('copy', 'App Review notes refused', st, d)
                print('  App Review notes written (%d chars)' % len(rel['reviewNotes']))
    if 'subtitle' in rel['copy']:
        # The subtitle lives on the appInfo, not the version: write it on the editable one.
        # The editable appInfo is created alongside the new version; until that version
        # exists (a dry run never creates it) only the live, read-only one is there.
        infos = []
        for attempt in range(4):
            st, d = req('GET', '/v1/apps/%s/appInfos' % app)
            infos = [i for i in (d.get('data') or [])
                     if ((i.get('attributes') or {}).get('state') or (i.get('attributes') or {}).get('appStoreState'))
                     not in ('READY_FOR_DISTRIBUTION', 'READY_FOR_SALE')]
            if infos or DRY:
                break
            time.sleep(5)
        if not infos and DRY:
            print('  [dry run] would write the subtitle %r once the new version exists' % rel['copy']['subtitle'])
            return
        if not infos:
            fail('copy', 'no editable appInfo for the subtitle', st, d)
        st, d = req('GET', '/v1/appInfos/%s/appInfoLocalizations' % infos[0]['id'])
        il = next((x for x in d.get('data') or [] if (x.get('attributes') or {}).get('locale') == 'en-US'), None)
        if not il:
            fail('copy', 'no en-US appInfo localization for the subtitle', st, d)
        st, d = write('PATCH', '/v1/appInfoLocalizations/%s' % il['id'],
                      {'data': {'type': 'appInfoLocalizations', 'id': il['id'],
                                'attributes': {'subtitle': rel['copy']['subtitle']}}}, 'subtitle')
        if not good(st):
            fail('copy', 'subtitle refused', st, d)


def upload(set_id, path):
    upload_asset('/v1/appScreenshots', 'appScreenshots',
                 {'appScreenshotSet': {'data': {'type': 'appScreenshotSets', 'id': set_id}}}, path, 'screenshots')


def upload_asset(create_path, rtype, relationships, path, step):
    """Apple's reserve → PUT the bytes → commit-with-checksum, for any binary asset."""
    data = open(path, 'rb').read()
    st, d = write('POST', create_path, {'data': {
        'type': rtype,
        'attributes': {'fileName': os.path.basename(path), 'fileSize': len(data)},
        'relationships': relationships}},
        'reserve %s' % os.path.basename(path))
    if not good(st):
        fail(step, 'reserve %s refused' % os.path.basename(path), st, d)
    if DRY:
        return
    sid = d['data']['id']
    for op in d['data']['attributes'].get('uploadOperations') or []:
        r = urllib.request.Request(op['url'], data=data[op['offset']:op['offset'] + op['length']],
                                   method=op['method'])
        for h in op.get('requestHeaders') or []:
            r.add_header(h['name'], h['value'])
        try:
            urllib.request.urlopen(r, timeout=120).read()
        except Exception as e:                               # noqa: BLE001
            fail(step, 'upload of %s failed: %s' % (os.path.basename(path), e))
    st, d = req('PATCH', '%s/%s' % (create_path, sid), {'data': {
        'type': rtype, 'id': sid,
        'attributes': {'uploaded': True, 'sourceFileChecksum': hashlib.md5(data).hexdigest()}}})
    if not good(st):
        fail(step, 'commit of %s refused' % os.path.basename(path), st, d)


def step_screenshots(vid, rel):
    print('=== 5. screenshots')
    if not rel.get('screenshots'):
        print('  "screenshots" is false — leaving the sets as they are')
        return
    loc = localization(vid)
    st, d = req('GET', '/v1/appStoreVersionLocalizations/%s/appScreenshotSets' % loc['id']) \
        if loc['id'] != 'dry-run' else (200, {})
    sets = {(s.get('attributes') or {}).get('screenshotDisplayType'): s for s in d.get('data') or []}
    shots_dir = rel.get('screenshotsDir') or 'store/screenshots'
    uploaded = 0
    for disp, patterns in SHOT_SETS.items():
        files = []
        for p in patterns:
            files = sorted(glob.glob(os.path.join(shots_dir, p)))
            if files:
                break
        if not files and disp not in SHOT_REQUIRED:
            print('  %s: no local files — leaving that set alone' % disp)
            continue
        if not files:
            fail('screenshots', 'no files for %s in %s (%s)' % (disp, shots_dir, ', '.join(patterns)))
        files = files[:10]
        s = sets.get(disp)
        if not s:
            st, d = write('POST', '/v1/appScreenshotSets', {'data': {
                'type': 'appScreenshotSets', 'attributes': {'screenshotDisplayType': disp},
                'relationships': {'appStoreVersionLocalization': {'data': {
                    'type': 'appStoreVersionLocalizations', 'id': loc['id']}}}}}, 'create set %s' % disp)
            if not good(st):
                fail('screenshots', 'could not create %s' % disp, st, d)
            s = d['data']
        old = []
        if s['id'] != 'dry-run':
            st, d = req('GET', '/v1/appScreenshotSets/%s/appScreenshots' % s['id'])
            old = d.get('data') or []
        # Already exactly these files, in this order? Leave the set alone. Besides saving
        # a re-upload, it is the only way a re-run gets through: ASC refuses to delete a
        # screenshot while the version is READY_FOR_REVIEW in a draft submission.
        have = [(o.get('attributes') or {}).get('sourceFileChecksum') for o in old]
        want = [hashlib.md5(open(f, 'rb').read()).hexdigest() for f in files]
        if old and have == want:
            print('  %s: already these %d files — unchanged' % (disp, len(files)))
            continue
        print('  %s: deleting %d, uploading %d' % (disp, len(old), len(files)))
        for o in old:   # delete first, or the new shots land after the old ones
            st, d = write('DELETE', '/v1/appScreenshots/%s' % o['id'], None, 'delete old shot')
            if not good(st):
                fail('screenshots', 'could not delete %s' % o['id'], st, d)
        for f in files:
            upload(s['id'], f)
            uploaded += 1
    if uploaded and not DRY:
        wait_for_assets(loc['id'])


def wait_for_assets(loc_id, timeout=600):
    """ASC answers 409 to the submission item until every new shot is COMPLETE."""
    deadline = time.time() + timeout
    while True:
        pending = []
        st, d = req('GET', '/v1/appStoreVersionLocalizations/%s/appScreenshotSets' % loc_id)
        for s in d.get('data') or []:
            st2, d2 = req('GET', '/v1/appScreenshotSets/%s/appScreenshots' % s['id'])
            for sh in d2.get('data') or []:
                state = ((sh.get('attributes') or {}).get('assetDeliveryState') or {}).get('state')
                if state == 'FAILED':
                    fail('screenshots', '%s failed processing' % sh['attributes'].get('fileName'))
                if state != 'COMPLETE':
                    pending.append(sh['id'])
        if not pending:
            print('  all screenshots COMPLETE')
            return
        if time.time() > deadline:
            fail('screenshots', '%d screenshot(s) still processing after %ds' % (len(pending), timeout))
        time.sleep(15)


def list_iaps(app):
    st, d = req('GET', '/v1/apps/%s/inAppPurchasesV2?limit=200' % app)
    if not good(st):
        fail('iaps', 'cannot list in-app purchases', st, d)
    return d.get('data') or []


def find_iap(known, want, app, step):
    iap = next((i for i in known if i['id'] == want
                or (i.get('attributes') or {}).get('productId') == want), None)
    if not iap:
        fail(step, '%s is not an in-app purchase of app %s' % (want, app))
    return iap


def usd_price(iap_id):
    """The IAP's current manual USD price as a string ("0.99"), or None."""
    st, d = req('GET', '/v1/inAppPurchasePriceSchedules/%s/manualPrices?include=inAppPurchasePricePoint,territory'
                       '&fields[inAppPurchasePricePoints]=customerPrice&limit=200' % iap_id)
    if not good(st):
        fail('prices', 'cannot read the price of %s' % iap_id, st, d)
    pts = {i['id']: (i.get('attributes') or {}).get('customerPrice')
           for i in d.get('included') or [] if i.get('type') == 'inAppPurchasePricePoints'}
    for pr in d.get('data') or []:
        rel_ = pr.get('relationships') or {}
        if ((rel_.get('territory') or {}).get('data') or {}).get('id') == 'USA' and \
                not (pr.get('attributes') or {}).get('endDate'):
            return pts.get(((rel_.get('inAppPurchasePricePoint') or {}).get('data') or {}).get('id'))
    return None


def step_prices(app, rel):
    """Set each IAP's USD base price; Apple equalises the other 174 territories from it.
    Idempotent: an IAP already at its price is left alone. Read back before it counts."""
    print('=== prices')
    if not rel['iapPrices']:
        print('  none listed')
        return
    known = list_iaps(app)
    for want, price in rel['iapPrices'].items():
        iap = find_iap(known, want, app, 'prices')
        now_ = usd_price(iap['id'])
        print('  %s: USD %s -> %s' % (iap['id'], now_, price))
        if now_ == price:
            print('    already %s — nothing to change' % price)
            continue
        point, path = None, '/v2/inAppPurchases/%s/pricePoints?filter[territory]=USA&limit=200' % iap['id']
        while path and not point:
            st, d = req('GET', path)
            if not good(st):
                fail('prices', 'cannot list price points for %s' % iap['id'], st, d)
            point = next((p['id'] for p in d.get('data') or []
                          if (p.get('attributes') or {}).get('customerPrice') == price), None)
            nxt = (d.get('links') or {}).get('next')
            path = nxt[len(API):] if nxt and nxt.startswith(API) else None
        if not point:
            fail('prices', 'Apple has no USD %s price point for %s' % (price, iap['id']))
        st, d = write('POST', '/v1/inAppPurchasePriceSchedules', {
            'data': {'type': 'inAppPurchasePriceSchedules', 'relationships': {
                'inAppPurchase': {'data': {'type': 'inAppPurchases', 'id': iap['id']}},
                'baseTerritory': {'data': {'type': 'territories', 'id': 'USA'}},
                'manualPrices': {'data': [{'type': 'inAppPurchasePrices', 'id': '${p0}'}]}}},
            'included': [{'type': 'inAppPurchasePrices', 'id': '${p0}', 'attributes': {'startDate': None},
                          'relationships': {'inAppPurchasePricePoint': {'data': {
                              'type': 'inAppPurchasePricePoints', 'id': point}}}}]},
            'price %s at USD %s' % (iap['id'], price))
        if not good(st):
            fail('prices', 'App Store Connect refused the new price for %s' % iap['id'], st, d)
        if DRY:
            continue
        after = usd_price(iap['id'])
        if after != price:
            fail('prices', 'read back USD %s for %s, expected %s' % (after, iap['id'], price))
        print('    now USD %s (read back)' % after)
    STATUS.update(prices=rel['iapPrices'])


def en_loc(body):
    """The en-US IAP localization that ships: the pending one when there is one."""
    ens = [l for l in body.get('data') or [] if (l.get('attributes') or {}).get('locale') == 'en-US']
    return next((l for l in ens if (l.get('attributes') or {}).get('state') != 'APPROVED'), None) or (ens[0] if ens else None)


def unmodifiable(body):
    return any('UNMODIFIABLE' in (e.get('code') or '') or 'can not be modified' in (e.get('detail') or '')
               for e in (body.get('errors') or []))


def step_iap_copy(app, rel):
    """Bring each IAP's customer-facing copy, review note and review screenshot in line with
    the version being shipped. Every field is compared first and written only if it differs,
    and read back after. Runs before step 7, which then sends a changed IAP to review."""
    print('=== IAP copy')
    if not rel['iapCopy']:
        print('  none listed')
        return
    known = list_iaps(app)
    rel.setdefault('_iapChanged', set())
    by_hand = []   # (iap, field, value) Apple would not take through the API
    for want, c in rel['iapCopy'].items():
        iap = find_iap(known, want, app, 'iap copy')
        iid = iap['id']
        if 'name' in c or 'description' in c:
            st, d = req('GET', '/v2/inAppPurchases/%s/inAppPurchaseLocalizations' % iid)
            if not good(st):
                fail('iap copy', 'cannot read the localizations of %s' % iid, st, d)
            # An approved IAP carries its APPROVED en-US localization and, once its copy is
            # edited, a second en-US one in PREPARE_FOR_SUBMISSION. The pending one is the
            # one that ships: compare and write against it when it exists.
            loc = en_loc(d)
            if not loc:
                fail('iap copy', '%s has no en-US localization' % iid)
            cur = loc.get('attributes') or {}
            attrs = {f: c[f] for f in ('name', 'description') if f in c and cur.get(f) != c[f]}
            if attrs:
                print('  %s: %s' % (iid, ', '.join('%s %r -> %r' % (f, cur.get(f), attrs[f]) for f in attrs)))
                st, d = write('PATCH', '/v1/inAppPurchaseLocalizations/%s' % loc['id'], {'data': {
                    'type': 'inAppPurchaseLocalizations', 'id': loc['id'], 'attributes': attrs}},
                    'IAP %s name/description' % iid)
                if not good(st) and unmodifiable(d):
                    # An APPROVED IAP's localization is ACTIVE and the API cannot edit it
                    # (seen shipping Receiptless 2.1). What App Store Connect's page does is
                    # add a second en-US localization for review; try that, and only if it
                    # is refused too, hand the fields over to be typed on the page.
                    full = {'name': c.get('name', cur.get('name')), 'description': c.get('description', cur.get('description'))}
                    st2, d2 = write('POST', '/v1/inAppPurchaseLocalizations', {'data': {
                        'type': 'inAppPurchaseLocalizations', 'attributes': dict(full, locale='en-US'),
                        'relationships': {'inAppPurchaseV2': {'data': {'type': 'inAppPurchases', 'id': iid}}}}},
                        'new en-US localization for review on %s' % iid)
                    if good(st2):
                        print('  %s: approved copy is locked — added the new copy as a localization for review' % iid)
                        rel['_iapChanged'].add(iid)
                    else:
                        by_hand += [(iid, f, v) for f, v in attrs.items()]
                elif not good(st):
                    fail('iap copy', 'the new name/description for %s was refused' % iid, st, d)
                else:
                    rel['_iapChanged'].add(iid)
                if not DRY and iid in rel['_iapChanged']:
                    st, d = req('GET', '/v2/inAppPurchases/%s/inAppPurchaseLocalizations' % iid)
                    back = (en_loc(d) or {}).get('attributes') or {}
                    if any(back.get(f) != v for f, v in attrs.items()):
                        fail('iap copy', 'read back a different name/description for %s' % iid)
            else:
                print('  %s: name and description already right' % iid)
        if 'reviewNote' in c:
            st, d = req('GET', '/v2/inAppPurchases/%s' % iid)
            cur = ((d.get('data') or {}).get('attributes') or {}).get('reviewNote') if good(st) else None
            if cur != c['reviewNote']:
                st, d = write('PATCH', '/v2/inAppPurchases/%s' % iid, {'data': {
                    'type': 'inAppPurchases', 'id': iid, 'attributes': {'reviewNote': c['reviewNote']}}},
                    'IAP %s review note' % iid)
                if not good(st) and unmodifiable(d):
                    by_hand.append((iid, 'reviewNote', c['reviewNote']))
                elif not good(st):
                    fail('iap copy', 'the review note for %s was refused' % iid, st, d)
                else:
                    rel['_iapChanged'].add(iid)
                    print('  %s: review note updated' % iid)
            else:
                print('  %s: review note already right' % iid)
        if 'reviewScreenshot' in c:
            data = open(c['reviewScreenshot'], 'rb').read()
            md5 = hashlib.md5(data).hexdigest()
            st, d = req('GET', '/v2/inAppPurchases/%s/appStoreReviewScreenshot' % iid)
            old = (d.get('data') or None) if good(st) else None
            if old and ((old.get('attributes') or {}).get('sourceFileChecksum') == md5):
                print('  %s: review screenshot already this file' % iid)
            else:
                if old:
                    st, d = write('DELETE', '/v1/inAppPurchaseAppStoreReviewScreenshots/%s' % old['id'], None,
                                  'delete old IAP review screenshot')
                    if not good(st) and unmodifiable(d):
                        by_hand.append((iid, 'reviewScreenshot', c['reviewScreenshot']))
                        continue
                    if not good(st):
                        fail('iap copy', 'could not delete the old review screenshot of %s' % iid, st, d)
                upload_asset('/v1/inAppPurchaseAppStoreReviewScreenshots', 'inAppPurchaseAppStoreReviewScreenshots',
                             {'inAppPurchaseV2': {'data': {'type': 'inAppPurchases', 'id': iid}}},
                             c['reviewScreenshot'], 'iap copy')
                rel['_iapChanged'].add(iid)
                print('  %s: review screenshot replaced' % iid)
    if by_hand:
        # Stop BEFORE any submission: shipping the version while the purchase still
        # describes the old Pro is the mismatch this step exists to prevent.
        LABEL = {'name': 'Display Name', 'description': 'Description', 'reviewNote': 'Review Notes',
                 'reviewScreenshot': 'Review Screenshot'}
        print('\n✗ App Store Connect will not let the API edit an approved in-app purchase.')
        print('  Edit these on the IAP page (it takes them), Save, then recommit release.json:')
        for iid, f, v in by_hand:
            print('\n  %s → %s' % ('https://appstoreconnect.apple.com/apps/%s/distribution/iaps/%s' % (app, iid), LABEL[f]))
            print('    ' + str(v).replace('\n', '\n    '))
        STATUS.update(result='blocked', step='iap copy',
                      byHand=[{'iap': i, 'field': f, 'value': v} for i, f, v in by_hand])
        dump_status()
        sys.exit(1)
    STATUS.update(iapCopy=sorted(rel['iapCopy']))


def step_submission(app, vid):
    print('=== 6. review submission')
    st, d = req('GET', '/v1/reviewSubmissions?filter[app]=%s&filter[platform]=IOS&limit=20' % app)
    if not good(st):
        fail('submission', 'cannot list review submissions', st, d)
    subs = d.get('data') or []
    busy = [s for s in subs if (s.get('attributes') or {}).get('state') in ('WAITING_FOR_REVIEW', 'IN_REVIEW')]
    if busy:
        fail('submission', 'submission %s is already %s — one at a time' % (
            busy[0]['id'], busy[0]['attributes']['state']))
    draft = next((s for s in subs if (s.get('attributes') or {}).get('state')
                  in ('READY_FOR_REVIEW', 'UNRESOLVED_ISSUES')), None)
    if draft:
        sid = draft['id']
        print('  reusing %s (%s)' % (sid, draft['attributes']['state']))
    else:
        st, d = write('POST', '/v1/reviewSubmissions', {'data': {
            'type': 'reviewSubmissions', 'attributes': {'platform': 'IOS'},
            'relationships': {'app': {'data': {'type': 'apps', 'id': str(app)}}}}}, 'create submission')
        if not good(st):
            fail('submission', 'could not create a review submission', st, d)
        sid = d['data']['id']
        print('  created %s' % sid)
    items = read_items(sid)
    if not any(item_version(i) == vid for i in items):
        body = {'data': {'type': 'reviewSubmissionItems', 'relationships': {
            'reviewSubmission': {'data': {'type': 'reviewSubmissions', 'id': sid}},
            'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': vid}}}}}
        st, d = write('POST', '/v1/reviewSubmissionItems', body, 'add version item')
        if st == 409 and not DRY:   # asset state can lag the API by a few seconds
            time.sleep(30)
            st, d = req('POST', '/v1/reviewSubmissionItems', body)
        if not good(st):
            fail('submission', 'the version item was refused', st, d)
        print('  version item added')
    return sid


def read_items(sid):
    if sid == 'dry-run':
        return []
    # Without include= the items come back with no relationships at all, so the version
    # item is unrecognisable (the first real 2.1 run stopped on exactly that).
    st, d = req('GET', '/v1/reviewSubmissions/%s/items?include=appStoreVersion&limit=50' % sid)
    if not good(st):
        fail('read back', 'cannot read the submission items', st, d)
    return d.get('data') or []


def item_version(item):
    return (((item.get('relationships') or {}).get('appStoreVersion') or {}).get('data') or {}).get('id')


def step_iaps(app, rel):
    """Returns how many IAPs this submission must carry beyond the version."""
    print('=== 7. in-app purchases')
    if not rel['iaps']:
        print('  none listed')
        return 0, []
    st, d = req('GET', '/v1/apps/%s/inAppPurchasesV2?limit=200' % app)
    if not good(st):
        fail('iaps', 'cannot list in-app purchases', st, d)
    known = d.get('data') or []
    riding, pages = 0, []
    for want in rel['iaps']:
        iap = next((i for i in known if i['id'] == want
                    or (i.get('attributes') or {}).get('productId') == want), None)
        if not iap:
            fail('iaps', '%s is not an in-app purchase of app %s' % (want, app))
        a = iap.get('attributes') or {}
        state = a.get('state')
        page = 'https://appstoreconnect.apple.com/apps/%s/distribution/iaps/%s' % (app, iap['id'])
        print('  %s (%s): %s' % (a.get('name') or a.get('productId'), iap['id'], state))
        # An approved IAP whose copy this run changed must be reviewed again with this
        # version, whatever state Apple reports, or the new copy never goes live.
        changed = iap['id'] in rel.get('_iapChanged', ())
        # Copy edited by hand on the IAP page (the API cannot edit an ACTIVE localization)
        # leaves nothing for this run to detect: ask Apple, and let its answer decide.
        by_page = not changed and any(want == k or iap['id'] == k or a.get('productId') == k for k in rel.get('iapCopy', {}))
        if state in IAP_DONE and by_page:
            st, d = write('POST', '/v1/inAppPurchaseSubmissions', {'data': {
                'type': 'inAppPurchaseSubmissions',
                'relationships': {'inAppPurchaseV2': {'data': {'type': 'inAppPurchases', 'id': iap['id']}}}}},
                'submit IAP %s (copy edited on its page)' % iap['id'])
            if good(st):
                print('    approved, with copy edited on its page — submitted for review with the version')
                riding += 1
                pages.append(page)
            else:
                print('    approved; Apple has nothing pending to review (%s) — not counted' % '; '.join(explain(d))[:200])
            continue
        if state in IAP_DONE and not changed:
            print('    approved already — nothing to review, not counted')
            continue
        if state in IAP_DONE and changed:
            print('    approved, but its copy changed in this run — submitting it with the version')
        if state in IAP_QUEUED:
            riding += 1
            continue
        if state not in IAP_SUBMITTABLE and not (state in IAP_DONE and changed):
            fail('iaps', '%s is %s; it needs localization, review screenshot, price schedule AND '
                         'availability before it can be reviewed — %s' % (iap['id'], state, page))
        st, d = write('POST', '/v1/inAppPurchaseSubmissions', {'data': {
            'type': 'inAppPurchaseSubmissions',
            'relationships': {'inAppPurchaseV2': {'data': {'type': 'inAppPurchases', 'id': iap['id']}}}}},
            'submit IAP %s' % iap['id'])
        if not good(st):
            print('\n✗ Apple refused POST /v1/inAppPurchaseSubmissions for %s (HTTP %s):' % (iap['id'], st))
            for line in explain(d):
                print('   ' + line)
            print('\n  NOT SUBMITTING. The one tap that attaches it: open %s on the phone, then\n'
                  '  "Add for Review" ▾ → the Draft iOS Submission. Then restart this lane\n'
                  '  (Codemagic → release → Start new build, or recommit release.json) and it\n'
                  '  will find the draft, read back the items and submit.' % page)
            STATUS.update(result='blocked', step='iaps', tap=page)
            dump_status()
            sys.exit(1)
        print('    submitted for review with this version')
        riding += 1
        pages.append(page)
    return riding, pages


def step_submit(sid, vid, rel, riding, pages):
    print('=== 8. read back, then submit')
    # What Apple actually does (first real run, 2026-09-24): the version is the submission's
    # item; an IAP put into review through POST /v1/inAppPurchaseSubmissions does NOT appear
    # among the items — Apple's 201 on that POST is its confirmation, and step 7 counts an
    # IAP as riding only on that 201 (or when it is already WAITING_FOR_REVIEW). A refused
    # IAP never gets here: step 7 stops the lane. So the guard before submitted:true is:
    # the version must be an item, and nothing else may be in the submission that this run
    # did not put there.
    items = read_items(sid)
    has_version = any(item_version(i) == vid for i in items)
    others = [i for i in items if item_version(i) != vid]
    print('  submission %s: version item %s; %d other item(s); %d IAP(s) accepted for review with it' % (
        sid, 'present' if has_version else 'MISSING', len(others), riding))
    STATUS.update(submission=sid, items=len(items), iapsInReview=riding)
    if not DRY and not has_version:
        fail('read back', 'the version is not an item of submission %s' % sid)
    if not DRY and len(others) > riding:
        print('\n✗ NOT SUBMITTING: submission %s holds %d item(s) this run did not add.' % (sid, len(others)))
        STATUS.update(result='blocked', step='read back')
        dump_status()
        sys.exit(1)
    if not rel.get('submit'):
        print('\n✓ everything is written and the submission is a ready draft. "submit" is false,\n'
              '  so it stops here; set it to true and recommit release.json to hand it to Apple.')
        STATUS.update(result='ready')
        return
    st, d = write('PATCH', '/v1/reviewSubmissions/%s' % sid,
                  {'data': {'type': 'reviewSubmissions', 'id': sid, 'attributes': {'submitted': True}}},
                  'SUBMIT for review')
    if not good(st):
        fail('submit', 'App Store Connect refused the submission', st, d)
    if DRY:
        print('\n✓ dry run complete: every read passed; the writes above are what a real run sends.')
        STATUS.update(result='dry-run')
        return
    state = ((d.get('data') or {}).get('attributes') or {}).get('state')
    print('\n✓ submitted for review: %s version %s build %s (%s)' % (sid, rel['version'], rel['build'], state))
    STATUS.update(result='submitted', state=state)


def resolve_app():
    """ASC_APP_ID when it is set; otherwise the app record whose bundle ID is BUNDLE_ID.
    The lookup is what lets a new app ship without anyone copying its numeric id around:
    the record exists from Jonathan's New App tap, and the bundle ID is fixed by convention."""
    app = os.environ.get('ASC_APP_ID', '').strip()
    if app.isdigit():
        return app
    bundle = os.environ.get('BUNDLE_ID', '').strip()
    if not bundle:
        fail('setup', 'set ASC_APP_ID (numeric) or BUNDLE_ID so the app can be looked up')
    st, body = req('GET', '/v1/apps?filter[bundleId]=%s&limit=10' % urllib.parse.quote(bundle))
    if not good(st):
        fail('setup', 'could not look up the app for bundle %s' % bundle, st, body)
    ids = [a['id'] for a in body.get('data') or []
           if (a.get('attributes') or {}).get('bundleId') == bundle]
    if len(ids) != 1:
        fail('setup', 'App Store Connect has %d app records for bundle %s (need exactly 1). '
             'None means the New App step of the setup card has not been done.' % (len(ids), bundle))
    print('release: bundle %s is App Store Connect app %s' % (bundle, ids[0]))
    return ids[0]


def main(argv):
    path = argv[1] if len(argv) > 1 else 'release.json'
    rel = load_release(path)
    app = resolve_app()
    STATUS.update(app=app, version=rel['version'], build=rel['build'], dry_run=DRY)
    if ONLY == 'prices':
        print('release: app %s — prices only%s' % (app, '  [DRY RUN — nothing is written]' if DRY else ''))
        step_prices(app, rel)
        STATUS.update(result='dry-run' if DRY else 'priced')
        dump_status()
        return 0
    if ONLY:
        fail('setup', 'ONLY=%s is not a mode this lane has (only "prices")' % ONLY)
    print('release: app %s version %s build %s submit=%s iaps=%s screenshots=%s%s' % (
        app, rel['version'], rel['build'], rel.get('submit'), rel['iaps'] or '-',
        bool(rel.get('screenshots')), '  [DRY RUN — nothing is written]' if DRY else ''))
    bid = step_build(app, rel)
    vid = step_version(app, rel)
    step_attach(vid, bid, rel)
    step_copy(app, vid, rel)
    step_screenshots(vid, rel)
    step_prices(app, rel)
    step_iap_copy(app, rel)
    sid = step_submission(app, vid)
    riding, pages = step_iaps(app, rel)
    step_submit(sid, vid, rel, riding, pages)
    dump_status()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
