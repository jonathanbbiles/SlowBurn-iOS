#!/usr/bin/env node
/* verify-release.js — the gate for the `release` lane (scripts/release.py).
 *
 * The lane is the only thing in this repo that can hand the app to App Review, so the
 * gate does not read it as text and hope: it RUNS it, against a fake App Store Connect
 * on 127.0.0.1, through every path that matters, and checks what it actually sent.
 *
 * The invariant it exists for: `submitted: true` is never sent unless the submission's
 * items were read back first and came to exactly 1 + (IAPs riding along). An app version
 * reviewed without the IAP it sells is the 2.1(b) rejection, and App Store Connect takes
 * such a submission without complaint.
 *
 * Needs python3 (present on every Codemagic Mac and in the cloud container); no network,
 * no credentials, no node_modules.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release.py');
const APP = '1000000001';
const BUILD = '202609231200';
let failed = 0;
const check = (name, ok, why = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !why ? '' : '\n        ' + why}`);
  if (!ok) failed++;
};

/* ------------------------------------------------------------- fake ASC -- */
function fakeAsc(opts) {
  const S = {
    build: { id: 'b1', state: opts.buildState || 'VALID', version: opts.buildVersion || '2.1' },
    versions: (opts.versions || []).map((v) => ({ ...v })),
    iaps: (opts.iaps || []).map((i) => ({ ...i })),
    subs: opts.extraItem ? [{ id: 's1', state: 'READY_FOR_REVIEW' }] : [], items: opts.extraItem ? [{ type: 'reviewSubmissionItems', id: 'x1', relationships: { appEvent: { data: { type: 'appEvents', id: 'e1' } } } }] : [],
    log: [], notes: opts.notes || 'old notes',
  };
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const conflict = (res, detail) => json(res, 409, { errors: [{ code: 'STATE_ERROR', title: 'conflict', detail,
    meta: { associatedErrors: { '/v1/fake': [{ code: 'FAKE.REASON', detail: 'named by the fake' }] } } }] });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      const entry = { method: req.method, path: p, body };
      S.log.push(entry);
      const m = (re) => p.match(re);
      if (req.method === 'GET' && p === '/v1/apps') {
        const b = u.searchParams.get('filter[bundleId]');
        return json(res, 200, { data: (opts.appRecords || []).filter((r) => r.bundleId === b).map((r) => ({ type: 'apps', id: r.id, attributes: { bundleId: r.bundleId } })) });
      }
      if (req.method === 'GET' && p === '/v1/builds') {
        return json(res, 200, { data: [{ type: 'builds', id: S.build.id,
          attributes: { version: BUILD, processingState: S.build.state, expired: false },
          relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'pr1' } } } }],
          included: [{ type: 'preReleaseVersions', id: 'pr1', attributes: { version: S.build.version } }] });
      }
      if (req.method === 'GET' && m(/^\/v1\/apps\/\d+\/appStoreVersions$/)) {
        return json(res, 200, { data: S.versions.map((v) => ({ type: 'appStoreVersions', id: v.id, attributes: { versionString: v.versionString, appStoreState: v.state } })) });
      }
      if (req.method === 'POST' && p === '/v1/appStoreVersions') {
        const v = { id: 'v' + (S.versions.length + 1), versionString: body.data.attributes.versionString, state: 'PREPARE_FOR_SUBMISSION' };
        S.versions.push(v);
        return json(res, 201, { data: { type: 'appStoreVersions', id: v.id, attributes: {} } });
      }
      if (req.method === 'GET' && m(/^\/v1\/appStoreVersions\/[^/]+\/build$/)) { const vv = S.versions.find((x) => p.split('/')[3] === x.id); return json(res, 200, { data: vv && vv.build ? { type: 'builds', id: vv.build } : null }); }
      if (req.method === 'PATCH' && m(/^\/v1\/appStoreVersions\/[^/]+\/relationships\/build$/)) {
        const vv = S.versions.find((x) => p.split('/')[3] === x.id); if (vv && vv.state === 'READY_FOR_REVIEW') return json(res, 409, { errors: [{ code: 'STATE_ERROR', detail: 'in a submission' }] });
        if (vv) vv.build = body.data.id; return json(res, 204);
      }
      if (req.method === 'GET' && m(/\/appStoreVersionLocalizations$/)) return json(res, 200, { data: [{ type: 'appStoreVersionLocalizations', id: 'l1', attributes: { locale: 'en-US' } }] });
      if (req.method === 'GET' && p === '/v1/appStoreVersionLocalizations/l1/appScreenshotSets') return json(res, 200, { data: [{ type: 'appScreenshotSets', id: 'set67', attributes: { screenshotDisplayType: 'APP_IPHONE_67' } }] });
      if (req.method === 'GET' && p === '/v1/appScreenshotSets/set67/appScreenshots') {
        const sums = opts.shotsOnAsc === 'same' ? SHOT_SUMS : ['aaa', 'bbb'];
        return json(res, 200, { data: sums.map((c, i) => ({ type: 'appScreenshots', id: 'as' + i, attributes: { sourceFileChecksum: c, assetDeliveryState: { state: 'COMPLETE' } } })) });
      }
      if (req.method === 'DELETE' && m(/^\/v1\/appScreenshots\//)) return json(res, 204);
      if (req.method === 'POST' && p === '/v1/appScreenshots') return json(res, 201, { data: { type: 'appScreenshots', id: 'new' + S.log.length, attributes: { uploadOperations: [{ method: 'PUT', url: 'http://' + req.headers.host + '/upload', offset: 0, length: body.data.attributes.fileSize, requestHeaders: [] }] } } });
      if (req.method === 'PATCH' && m(/^\/v1\/appScreenshots\//)) return json(res, 200, { data: {} });
      if (req.method === 'PATCH' && m(/^\/v1\/appStoreVersionLocalizations\//)) return json(res, 200, { data: { id: 'l1' } });
      if (req.method === 'GET' && m(/^\/v1\/appStoreVersions\/[^/]+\/appStoreReviewDetail$/)) return json(res, 200, { data: { type: 'appStoreReviewDetails', id: 'rd1', attributes: { notes: S.notes } } });
      if (req.method === 'PATCH' && p === '/v1/appStoreReviewDetails/rd1') { S.notes = body.data.attributes.notes; return json(res, 200, { data: { id: 'rd1' } }); }
      if (req.method === 'GET' && m(/^\/v1\/apps\/\d+\/inAppPurchasesV2$/)) {
        return json(res, 200, { data: S.iaps.map((i) => ({ type: 'inAppPurchases', id: i.id, attributes: { productId: i.productId, name: i.name, state: i.state } })) });
      }
      if (req.method === 'GET' && p === '/v1/reviewSubmissions') {
        return json(res, 200, { data: S.subs.map((s) => ({ type: 'reviewSubmissions', id: s.id, attributes: { state: s.state } })) });
      }
      if (req.method === 'POST' && p === '/v1/reviewSubmissions') {
        const s = { id: 's' + (S.subs.length + 1), state: 'READY_FOR_REVIEW' };
        S.subs.push(s);
        return json(res, 201, { data: { type: 'reviewSubmissions', id: s.id, attributes: { state: s.state } } });
      }
      if (req.method === 'GET' && m(/^\/v1\/reviewSubmissions\/[^/]+\/items$/)) {
        entry.returned = S.items.length;
        // The real API returns items with NO relationships unless include= asks for them.
        const inc = (u.searchParams.get('include') || '').split(',').includes('appStoreVersion');
        return json(res, 200, { data: S.items.map((it) => inc ? it : { type: it.type, id: it.id, attributes: { state: 'READY_FOR_REVIEW' } }) });
      }
      if (req.method === 'POST' && p === '/v1/reviewSubmissionItems') {
        const vid = body.data.relationships.appStoreVersion.data.id;
        S.items.push({ type: 'reviewSubmissionItems', id: 'i' + (S.items.length + 1), relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: vid } } } });
        return json(res, 201, { data: { id: 'i' + S.items.length } });
      }
      if (req.method === 'POST' && p === '/v1/inAppPurchaseSubmissions') {
        if (opts.iapPost === 'refuse') return conflict(res, 'first IAP must be added from the version page');
        const id = body.data.relationships.inAppPurchaseV2.data.id;
        const iap = S.iaps.find((i) => i.id === id);
        if (iap) iap.state = 'WAITING_FOR_REVIEW';
        if (opts.iapPost === 'adds-item') S.items.push({ type: 'reviewSubmissionItems', id: 'i' + (S.items.length + 1), relationships: {} });   // a UI-attached IAP
        return json(res, 201, { data: { type: 'inAppPurchaseSubmissions', id: 'ips1' } });
      }
      // --- IAP copy: localization, review note, review screenshot ---
      const iapOf = (id) => S.iaps.find((i) => i.id === id);
      if (req.method === 'GET' && m(/^\/v2\/inAppPurchases\/[^/]+\/inAppPurchaseLocalizations$/)) {
        const iap = iapOf(p.split('/')[3]) || {};
        const rows = [{ type: 'inAppPurchaseLocalizations', id: 'loc-' + iap.id, attributes: { locale: 'en-US', name: iap.name, description: iap.desc, state: iap.state === 'APPROVED' ? 'APPROVED' : 'PREPARE_FOR_SUBMISSION' } }];
        if (iap.pending) rows.push({ type: 'inAppPurchaseLocalizations', id: 'pend-' + iap.id, attributes: { locale: 'en-US', name: iap.pending.name, description: iap.pending.desc, state: 'PREPARE_FOR_SUBMISSION' } });
        return json(res, 200, { data: rows });
      }
      const locked = (res2) => json(res2, 409, { errors: [{ code: 'ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE', title: 'unmodifiable',
        detail: 'Cannot edit InAppPurchaseLocalization when it is in ACTIVE state' }] });
      if (req.method === 'PATCH' && m(/^\/v1\/inAppPurchaseLocalizations\/loc-[^/]+$/)) {
        const iap = iapOf(p.split('/')[3].slice(4)); const a = body.data.attributes;
        if (opts.activeLocked && iap.state === 'APPROVED') return locked(res);
        if (a.name !== undefined) iap.name = a.name; if (a.description !== undefined) iap.desc = a.description;
        if (iap.state === 'APPROVED' && !opts.keepApproved) iap.state = 'READY_TO_SUBMIT';   // Apple may or may not flip it
        return json(res, 200, { data: { id: 'loc-' + iap.id } });
      }
      if (req.method === 'POST' && p === '/v1/inAppPurchaseLocalizations') {
        if (opts.noNewLocalization) return locked(res);
        const iap = iapOf(body.data.relationships.inAppPurchaseV2.data.id);
        iap.pending = { name: body.data.attributes.name, desc: body.data.attributes.description };
        return json(res, 201, { data: { type: 'inAppPurchaseLocalizations', id: 'pend-' + iap.id } });
      }
      if (req.method === 'GET' && m(/^\/v2\/inAppPurchases\/[^/]+$/)) {
        const iap = iapOf(p.split('/')[3]) || {};
        return json(res, 200, { data: { type: 'inAppPurchases', id: iap.id, attributes: { reviewNote: iap.note || null } } });
      }
      if (req.method === 'PATCH' && m(/^\/v2\/inAppPurchases\/[^/]+$/)) {
        const iap = iapOf(p.split('/')[3]); iap.note = body.data.attributes.reviewNote;
        return json(res, 200, { data: { id: iap.id } });
      }
      if (req.method === 'GET' && m(/^\/v2\/inAppPurchases\/[^/]+\/appStoreReviewScreenshot$/)) {
        const iap = iapOf(p.split('/')[3]) || {};
        return json(res, 200, { data: iap.shot ? { type: 'inAppPurchaseAppStoreReviewScreenshots', id: 'shot-' + iap.id, attributes: { sourceFileChecksum: iap.shot } } : null });
      }
      if (req.method === 'DELETE' && m(/^\/v1\/inAppPurchaseAppStoreReviewScreenshots\/shot-/)) { const iap = iapOf(p.split('/')[3].slice(5)); if (iap) iap.shot = null; return json(res, 204); }
      if (req.method === 'POST' && p === '/v1/inAppPurchaseAppStoreReviewScreenshots') {
        const id = body.data.relationships.inAppPurchaseV2.data.id;
        return json(res, 201, { data: { type: 'inAppPurchaseAppStoreReviewScreenshots', id: 'new-' + id, attributes: {
          uploadOperations: [{ method: 'PUT', url: 'http://' + req.headers.host + '/upload', offset: 0, length: body.data.attributes.fileSize, requestHeaders: [] }] } } });
      }
      if (req.method === 'PUT' && p === '/upload') { entry.bytes = raw.length; return json(res, 200); }
      if (req.method === 'PATCH' && m(/^\/v1\/inAppPurchaseAppStoreReviewScreenshots\/new-/)) {
        const iap = iapOf(p.split('/')[3].slice(4)); if (iap && body.data.attributes.uploaded) iap.shot = body.data.attributes.sourceFileChecksum;
        return json(res, 200, { data: { id: 'shot-' + (iap && iap.id) } });
      }
      if (req.method === 'GET' && m(/^\/v1\/inAppPurchasePriceSchedules\/[^/]+\/manualPrices$/)) {
        const iap = S.iaps.find((i) => p.split('/')[3] === i.id) || {};
        const pp = 'pp-' + (iap.price || '0.99');
        return json(res, 200, { data: [{ type: 'inAppPurchasePrices', id: 'pr1', attributes: { startDate: null, endDate: null },
          relationships: { inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: pp } }, territory: { data: { type: 'territories', id: 'USA' } } } }],
          included: [{ type: 'inAppPurchasePricePoints', id: pp, attributes: { customerPrice: iap.price || '0.99' } }] });
      }
      if (req.method === 'GET' && m(/^\/v2\/inAppPurchases\/[^/]+\/pricePoints$/)) {
        return json(res, 200, { data: ['0.99', '9.99', '19.99'].map((c) => ({ type: 'inAppPurchasePricePoints', id: 'pp-' + c, attributes: { customerPrice: c } })) });
      }
      if (req.method === 'POST' && p === '/v1/inAppPurchasePriceSchedules') {
        const iap = S.iaps.find((i) => i.id === body.data.relationships.inAppPurchase.data.id);
        const pt = body.included[0].relationships.inAppPurchasePricePoint.data.id;
        if (!pt) return json(res, 422, { errors: [{ code: 'ENTITY_ERROR', title: 'no price point', detail: 'missing' }] });
        if (iap) iap.price = pt.replace('pp-', '');
        return json(res, 201, { data: { type: 'inAppPurchasePriceSchedules', id: iap ? iap.id : 'x' } });
      }
      if (req.method === 'PATCH' && m(/^\/v1\/reviewSubmissions\/[^/]+$/)) {
        const s = S.subs.find((x) => p.endsWith('/' + x.id));
        if (body.data.attributes.submitted && s) s.state = 'WAITING_FOR_REVIEW';
        return json(res, 200, { data: { id: s && s.id, attributes: { state: s && s.state } } });
      }
      return json(res, 404, { errors: [{ code: 'NOT_FOUND', title: 'fake has no route', detail: req.method + ' ' + p }] });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ S, server, port: server.address().port })));
}

function runLane(port, release, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
  const file = path.join(dir, 'release.json');
  fs.writeFileSync(file, JSON.stringify(release));
  return new Promise((resolve) => {
    const child = spawn('python3', [SCRIPT, file], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, ASC_API_BASE: `http://127.0.0.1:${port}`, ASC_APP_ID: APP, ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => { fs.rmSync(dir, { recursive: true, force: true }); resolve({ code, out }); });
  });
}

const submittedCalls = (S) => S.log.filter((e) => e.method === 'PATCH' && /^\/v1\/reviewSubmissions\/[^/]+$/.test(e.path) && e.body && e.body.data.attributes.submitted === true);
const writes = (S) => S.log.filter((e) => e.method !== 'GET');
/* The invariant, checked on the recorded traffic: the last items read-back BEFORE the
 * submit returned exactly the expected count. */
function readBackBeforeSubmit(S, expected) {
  const i = S.log.findIndex((e) => submittedCalls(S).includes(e));
  if (i < 0) return false;
  const reads = S.log.slice(0, i).filter((e) => e.method === 'GET' && /\/items$/.test(e.path));
  return reads.length > 0 && reads[reads.length - 1].returned === expected;
}

const base = { version: '2.1', build: BUILD, submit: true, iaps: [], screenshots: false, whatsNew: 'Fixes.' };
const PRO = { id: '6797705239', productId: 'com.example.pro', name: 'Tax Pro' };
const SHOT = path.join(os.tmpdir(), 'release-gate-iap-review.png');
const SHOTDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-shots-'));
['6.9in-a_1.png', '6.9in-a_2.png'].forEach((f, i) => fs.writeFileSync(path.join(SHOTDIR, f), Buffer.from('shot' + i)));
const SHOT_SUMS = ['6.9in-a_1.png', '6.9in-a_2.png'].map((f) => require('crypto').createHash('md5').update(fs.readFileSync(path.join(SHOTDIR, f))).digest('hex'));
const NOTES = path.join(os.tmpdir(), 'release-gate-notes.txt');
fs.writeFileSync(NOTES, 'Tax Pro tab → Get Tax Pro.\n');
fs.writeFileSync(SHOT, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
const SHOT_MD5 = require('crypto').createHash('md5').update(fs.readFileSync(SHOT)).digest('hex');
const NEWCOPY = { name: 'Receiptless Tax Pro', description: 'Unlimited auto trips, IRS mileage log, Schedule C pack', reviewNote: 'Tax Pro tab → Get Tax Pro.', reviewScreenshot: SHOT };
const OLDIAP = { ...PRO, name: 'Receiptless Pro', desc: 'Export to PDF/CSV, full reports, reminders, categories', note: 'Settings > Receiptless Pro', shot: 'oldmd5', state: 'APPROVED', price: '19.99' };

const SCENARIOS = [
  ['version only: submits after reading back 1 item', {}, base, (r, S) => {
    check('exit 0', r.code === 0, r.out);
    check('sent submitted:true exactly once', submittedCalls(S).length === 1);
    check('read back 1 item before submitting', readBackBeforeSubmit(S, 1));
  }],
  ['IAP accepted and joins the submission: submits at 2 items', { iaps: [{ ...PRO, state: 'READY_TO_SUBMIT' }], iapPost: 'adds-item' },
    { ...base, iaps: [PRO.id] }, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('POSTed the IAP submission', S.log.some((e) => e.method === 'POST' && e.path === '/v1/inAppPurchaseSubmissions'));
      check('read back 2 items before submitting', readBackBeforeSubmit(S, 2));
    }],
  ['IAP POST refused: never submits, names the IAP page', { iaps: [{ ...PRO, state: 'READY_TO_SUBMIT' }], iapPost: 'refuse' },
    { ...base, iaps: [PRO.id] }, (r, S) => {
      check('exit 1', r.code === 1, r.out);
      check('did not send submitted:true', submittedCalls(S).length === 0);
      check('prints the IAP page to tap', r.out.includes(`/apps/${APP}/distribution/iaps/${PRO.id}`), r.out);
      check("prints Apple's associatedErrors", r.out.includes('FAKE.REASON'), r.out);
    }],
  ['IAP accepted by inAppPurchaseSubmissions and not listed as an item (what Apple does): submits', { iaps: [{ ...PRO, state: 'READY_TO_SUBMIT' }], iapPost: 'no-item' },
    { ...base, iaps: [PRO.id] }, (r, S) => {
      const iIap = S.log.findIndex((e) => e.path === '/v1/inAppPurchaseSubmissions');
      check('exit 0', r.code === 0, r.out);
      check('Apple accepted the IAP before submitted:true, and the version item was read back first',
        iIap >= 0 && iIap < S.log.findIndex((e) => submittedCalls(S).includes(e)) && readBackBeforeSubmit(S, 1));
    }],
  ['an item in the draft this run did not add: never submits', { iaps: [], extraItem: true }, base, (r, S) => {
    check('exit 1', r.code === 1, r.out);
    check('did not send submitted:true', submittedCalls(S).length === 0);
  }],
  ['IAP already approved: not counted, submits at 1 item', { iaps: [{ ...PRO, state: 'APPROVED' }] },
    { ...base, iaps: ['com.example.pro'] }, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('did not re-submit the approved IAP', !S.log.some((e) => e.path === '/v1/inAppPurchaseSubmissions'));
      check('read back 1 item before submitting', readBackBeforeSubmit(S, 1));
    }],
  ['IAP missing metadata: stops before any submission', { iaps: [{ ...PRO, state: 'MISSING_METADATA' }] },
    { ...base, iaps: [PRO.id] }, (r, S) => {
      check('exit 1', r.code === 1, r.out);
      check('did not send submitted:true', submittedCalls(S).length === 0);
    }],
  ['"submit": false: writes the draft, stops before submitting', {}, { ...base, submit: false }, (r, S) => {
    check('exit 0', r.code === 0, r.out);
    check('did not send submitted:true', submittedCalls(S).length === 0);
    check('the version item is in the draft', S.items.length === 1);
  }],
  ['build still PROCESSING: writes nothing', { buildState: 'PROCESSING' }, base, (r, S) => {
    check('exit 1', r.code === 1, r.out);
    check('no write of any kind', writes(S).length === 0, JSON.stringify(writes(S)));
  }],
  ['build carries a different marketing version: writes nothing', { buildVersion: '2.1.0' }, base, (r, S) => {
    check('exit 1', r.code === 1, r.out);
    check('no write of any kind', writes(S).length === 0);
  }],
  ['a re-run on a version left READY_FOR_REVIEW in an unsent draft: resumes, keeps the attached build, submits',
    { versions: [{ id: 'v9', versionString: '2.1', state: 'READY_FOR_REVIEW', build: 'b1' }] }, base, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('did not try to re-attach the build', !S.log.some((e) => e.method === 'PATCH' && /relationships\/build/.test(e.path)));
      check('submitted after reading back the version item', readBackBeforeSubmit(S, 1));
    }],
  ['screenshots already these files: left alone (ASC will not delete them in a draft)', { shotsOnAsc: 'same' },
    { ...base, screenshots: true, screenshotsDir: SHOTDIR }, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('no screenshot delete or upload', !S.log.some((e) => e.method !== 'GET' && /appScreenshot/.test(e.path)), JSON.stringify(writes(S).map((e) => e.method + ' ' + e.path)));
    }],
  ['screenshots differ: old deleted first, new uploaded', { shotsOnAsc: 'other' },
    { ...base, screenshots: true, screenshotsDir: SHOTDIR }, (r, S) => {
      const iDel = S.log.findIndex((e) => e.method === 'DELETE' && /appScreenshots\//.test(e.path));
      const iNew = S.log.findIndex((e) => e.method === 'POST' && e.path === '/v1/appScreenshots');
      check('exit 0', r.code === 0, r.out);
      check('delete before upload', iDel >= 0 && iNew > iDel);
    }],
  ['version already WAITING_FOR_REVIEW: a re-run is a no-op', { versions: [{ id: 'v9', versionString: '2.1', state: 'WAITING_FOR_REVIEW' }] }, base, (r, S) => {
    check('exit 0', r.code === 0, r.out);
    check('no write of any kind', writes(S).length === 0);
  }],
  ['DRY_RUN=1: reads only', { iaps: [{ ...PRO, state: 'READY_TO_SUBMIT' }] }, { ...base, iaps: [PRO.id] }, (r, S) => {
    check('exit 0', r.code === 0, r.out);
    check('no write of any kind', writes(S).length === 0, JSON.stringify(writes(S)));
  }, { DRY_RUN: '1' }],
  ['ONLY=prices: moves the price, reads it back, touches nothing else', { iaps: [{ ...PRO, state: 'APPROVED', price: '0.99' }] },
    { iapPrices: { [PRO.id]: '19.99' } }, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('one price-schedule POST, at the 19.99 point', S.log.filter((e) => e.path === '/v1/inAppPurchasePriceSchedules').length === 1 &&
        S.log.find((e) => e.path === '/v1/inAppPurchasePriceSchedules').body.included[0].relationships.inAppPurchasePricePoint.data.id === 'pp-19.99');
      check('the new price was read back', S.iaps[0].price === '19.99' && /now USD 19\.99 \(read back\)/.test(r.out), r.out);
      check('no version, build or submission request', !S.log.some((e) => /appStoreVersions|builds|reviewSubmission/.test(e.path)));
    }, { ONLY: 'prices' }],
  ['ONLY=prices when the price is already right: writes nothing', { iaps: [{ ...PRO, state: 'APPROVED', price: '19.99' }] },
    { iapPrices: { 'com.example.pro': '19.99' } }, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('no write of any kind', writes(S).length === 0);
    }, { ONLY: 'prices' }],
  ['a price Apple does not offer: refuses, writes nothing', { iaps: [{ ...PRO, state: 'APPROVED', price: '0.99' }] },
    { iapPrices: { [PRO.id]: '18.50' } }, (r, S) => {
      check('exit 1', r.code === 1, r.out);
      check('no write of any kind', writes(S).length === 0);
    }, { ONLY: 'prices' }],
  ['a full release reprices before it submits', { iaps: [{ ...PRO, state: 'APPROVED', price: '0.99' }] },
    { ...base, iaps: [PRO.id], iapPrices: { [PRO.id]: '19.99' } }, (r, S) => {
      const iPrice = S.log.findIndex((e) => e.path === '/v1/inAppPurchasePriceSchedules');
      const iSubmit = S.log.findIndex((e) => submittedCalls(S).includes(e));
      check('exit 0', r.code === 0, r.out);
      check('the price is set before submitted:true', iPrice >= 0 && iSubmit > iPrice);
    }],
  ['IAP copy changed on an approved IAP: rewritten, read back, sent to review with the version', { iaps: [OLDIAP], iapPost: 'adds-item' },
    { ...base, iaps: [PRO.id], iapCopy: { [PRO.id]: NEWCOPY } }, (r, S) => {
      const i = (fn) => S.log.findIndex(fn);
      const iLoc = i((e) => e.method === 'PATCH' && /inAppPurchaseLocalizations/.test(e.path));
      const iNote = i((e) => e.method === 'PATCH' && /^\/v2\/inAppPurchases\/[^/]+$/.test(e.path));
      const iDel = i((e) => e.method === 'DELETE' && /ReviewScreenshots/.test(e.path));
      const iPut = i((e) => e.method === 'PUT' && e.path === '/upload');
      const iSub = i((e) => e.path === '/v1/inAppPurchaseSubmissions');
      const iGo = i((e) => submittedCalls(S).includes(e));
      check('exit 0', r.code === 0, r.out);
      check('name, description and review note are the new ones', S.iaps[0].name === NEWCOPY.name && S.iaps[0].desc === NEWCOPY.description && S.iaps[0].note === NEWCOPY.reviewNote);
      check('the old review screenshot is deleted before the new one is uploaded and committed', iDel >= 0 && iPut > iDel && S.iaps[0].shot === SHOT_MD5);
      check('the edited IAP is submitted for review, then the submission carries 2 items', iSub > Math.max(iLoc, iNote, iPut) && iGo > iSub && readBackBeforeSubmit(S, 2));
    }],
  ['IAP copy changed but Apple still reports APPROVED: submitted with the version anyway', { iaps: [OLDIAP], iapPost: 'adds-item', keepApproved: true },
    { ...base, iaps: [PRO.id], iapCopy: { [PRO.id]: NEWCOPY } }, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('the edited IAP is POSTed for review and the submission carries 2 items',
        S.log.some((e) => e.path === '/v1/inAppPurchaseSubmissions') && readBackBeforeSubmit(S, 2));
    }],
  ['Apple refuses to edit an ACTIVE IAP localization: every field tried, the by-hand list printed, nothing submitted',
    { iaps: [OLDIAP], activeLocked: true, noNewLocalization: true, iapPost: 'adds-item' }, { ...base, iaps: [PRO.id], iapCopy: { [PRO.id]: NEWCOPY } }, (r, S) => {
      check('exit 1', r.code === 1, r.out);
      check('names the IAP page and the Display Name and Description to type', /distribution\/iaps\/6797705239 → Display Name/.test(r.out) && /Receiptless Tax Pro/.test(r.out) && /→ Description/.test(r.out), r.out);
      check('still tried the review note and screenshot (they went through)', S.iaps[0].note === NEWCOPY.reviewNote && S.iaps[0].shot === SHOT_MD5);
      check('no IAP submission and no submitted:true', !S.log.some((e) => e.path === '/v1/inAppPurchaseSubmissions') && submittedCalls(S).length === 0);
    }],
  ['ACTIVE localization locked, but a new one for review is accepted: added, IAP submitted, 2 items',
    { iaps: [OLDIAP], activeLocked: true, iapPost: 'adds-item' }, { ...base, iaps: [PRO.id], iapCopy: { [PRO.id]: NEWCOPY } }, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('a new en-US localization carries the new copy', S.iaps[0].pending && S.iaps[0].pending.name === NEWCOPY.name && S.iaps[0].pending.desc === NEWCOPY.description);
      check('the IAP rides with the version: 2 items', S.log.some((e) => e.path === '/v1/inAppPurchaseSubmissions') && readBackBeforeSubmit(S, 2));
    }],
  ['copy edited on the IAP page (second, pending en-US localization): nothing re-typed, IAP submitted, 2 items',
    { iaps: [{ ...OLDIAP, note: NEWCOPY.reviewNote, shot: SHOT_MD5, pending: { name: NEWCOPY.name, desc: NEWCOPY.description } }], activeLocked: true, iapPost: 'adds-item' },
    { ...base, iaps: [PRO.id], iapCopy: { [PRO.id]: NEWCOPY } }, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('no localization write at all (the pending one already matches)', !S.log.some((e) => e.method !== 'GET' && /inAppPurchaseLocalizations/.test(e.path)));
      check('the IAP is offered for review and the submission carries 2 items', S.log.some((e) => e.path === '/v1/inAppPurchaseSubmissions') && readBackBeforeSubmit(S, 2));
    }],
  ['copy already edited by hand on an APPROVED IAP, Apple has it pending: submitted with the version', { iaps: [{ ...OLDIAP, name: NEWCOPY.name, desc: NEWCOPY.description, note: NEWCOPY.reviewNote, shot: SHOT_MD5 }], iapPost: 'adds-item' },
    { ...base, iaps: [PRO.id], iapCopy: { [PRO.id]: NEWCOPY } }, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('asked Apple to review it and submitted at 2 items', S.log.some((e) => e.path === '/v1/inAppPurchaseSubmissions') && readBackBeforeSubmit(S, 2));
    }],
  ['IAP copy already right and Apple has nothing pending: not resubmitted, 1 item', { iaps: [{ ...OLDIAP, name: NEWCOPY.name, desc: NEWCOPY.description, note: NEWCOPY.reviewNote, shot: SHOT_MD5 }], iapPost: 'refuse' },
    { ...base, iaps: [PRO.id], iapCopy: { [PRO.id]: NEWCOPY } }, (r, S) => {
      check('exit 0', r.code === 0, r.out);
      check('no localization, note or screenshot write', !S.log.some((e) => e.method !== 'GET' && /inAppPurchaseLocalizations|^\/v2\/inAppPurchases\/|ReviewScreenshots|\/upload/.test(e.path)));
      check('Apple refused the IAP submission, so 1 item and still submitted', readBackBeforeSubmit(S, 1));
    }],
  ['IAP copy with DRY_RUN=1: reads only', { iaps: [OLDIAP] }, { ...base, iaps: [PRO.id], iapCopy: { [PRO.id]: NEWCOPY } }, (r, S) => {
    check('exit 0', r.code === 0, r.out);
    check('no write of any kind', writes(S).length === 0, JSON.stringify(writes(S).map((e) => e.method + ' ' + e.path)));
  }, { DRY_RUN: '1' }],
  ['an IAP name over 30 characters: refused before any request', { iaps: [OLDIAP] },
    { ...base, iapCopy: { [PRO.id]: { name: 'Receiptless Tax Pro, the whole thing' } } }, (r, S) => {
      check('exit 1', r.code === 1, r.out);
      check('no request at all', S.log.length === 0);
    }],
  ['review notes: the version gets the file\'s text, before the submission', {},
    { ...base, reviewNotes: NOTES }, (r, S) => {
      const iN = S.log.findIndex((e) => e.path === '/v1/appStoreReviewDetails/rd1' && e.method === 'PATCH');
      check('exit 0', r.code === 0, r.out);
      check('the notes are the file\'s text', S.notes === 'Tax Pro tab → Get Tax Pro.');
      check('written before submitted:true', iN >= 0 && iN < S.log.findIndex((e) => submittedCalls(S).includes(e)));
    }],
  ['review notes already current: not rewritten', { notes: 'Tax Pro tab → Get Tax Pro.' }, { ...base, reviewNotes: NOTES }, (r, S) => {
    check('exit 0', r.code === 0, r.out);
    check('no notes write', !S.log.some((e) => e.path === '/v1/appStoreReviewDetails/rd1' && e.method === 'PATCH'));
  }],
  ['no ASC_APP_ID: the app is found by BUNDLE_ID and the lane submits', { appRecords: [{ id: APP, bundleId: 'com.example.app' }] }, base, (r, S) => {
    check('exit 0', r.code === 0, r.out);
    check('looked the app up by bundle ID', S.log.some((e) => e.method === 'GET' && e.path === '/v1/apps'));
    check('used the looked-up id', S.log.some((e) => e.path === `/v1/apps/${APP}/appStoreVersions`));
    check('sent submitted:true exactly once', submittedCalls(S).length === 1);
  }, { ASC_APP_ID: '', BUNDLE_ID: 'com.example.app' }],
  ['no ASC_APP_ID and no app record for the bundle: stops before any write', {}, base, (r, S) => {
    check('exit 1', r.code === 1, r.out);
    check('names the New App step', /New App/.test(r.out), r.out);
    check('no write', writes(S).length === 0);
  }, { ASC_APP_ID: '', BUNDLE_ID: 'com.example.app' }],
  ['keepCopy (a 1.0 resubmission): no What\'s New needed, no listing write, still submits', {}, { ...base, whatsNew: '', keepCopy: true }, (r, S) => {
    check('exit 0', r.code === 0, r.out);
    check('wrote no version localization', !S.log.some((e) => e.method === 'PATCH' && /appStoreVersionLocalizations/.test(e.path)));
    check('sent submitted:true exactly once', submittedCalls(S).length === 1);
  }],
  ['bad build number in release.json: refuses before any request', {}, { ...base, build: '19' }, (r, S) => {
    check('exit 1', r.code === 1, r.out);
    check('no request at all', S.log.length === 0);
  }],
];

(async () => {
  console.log('verify-release: the release lane against a fake App Store Connect');
  for (const [name, opts, release, assert, env] of SCENARIOS) {
    console.log(`\n${name}`);
    const { S, server, port } = await fakeAsc(opts);
    const r = await runLane(port, release, env);
    server.close();
    assert(r, S);
  }

  console.log('\nsource and pipeline');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const sends = src.match(/'submitted': True/g) || [];
  check("release.py sends 'submitted': True in exactly one place", sends.length === 1, `found ${sends.length}`);
  const at = src.indexOf("'submitted': True");
  const guard = src.lastIndexOf('len(others) > riding', at), vguard = src.lastIndexOf('if not DRY and not has_version', at);
  check('that one place comes after the version-item and extra-item checks', guard > 0 && vguard > 0 && guard < at && vguard < at);
  check('the read-back asks for the item relationships (the real API omits them otherwise)', /items\?include=appStoreVersion/.test(src));
  check('the lane refuses any API host but ASC and localhost', /ASC_API_BASE must be App Store Connect or 127\.0\.0\.1/.test(src));

  // A standalone app repo keeps codemagic.yaml beside it with `release` / `ios-testflight`;
  // an app inside the app-factory monorepo (apps/<slug>/) is built by the ROOT codemagic.yaml
  // with `<slug>-release` / `<slug>-testflight`. Same checks, either layout.
  const mono = ROOT.match(/[\\/]apps[\\/]([^\\/]+)$/);
  // The template itself has no workflows of its own: check the pair it is instantiated with.
  const tpl = mono && mono[1] === '.template';
  const cmPath = tpl ? path.join(ROOT, '..', '..', 'templates', 'codemagic-app-workflows.yaml')
    : mono ? path.join(ROOT, '..', '..', 'codemagic.yaml') : path.join(ROOT, 'codemagic.yaml');
  const cm = fs.readFileSync(cmPath, 'utf8');
  const block = (name) => { const m = cm.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][\\w.-]*:\\n|$)`)); return m ? m[1] : ''; };
  const slug = tpl ? '__SLUG__' : mono && mono[1];
  const rel = block(slug ? `${slug}-release` : 'release'), tf = block(slug ? `${slug}-testflight` : 'ios-testflight');
  check('codemagic.yaml has a release workflow', rel.length > 0);
  check('release triggers on push to main', /triggering:[\s\S]*events:[\s\S]*push[\s\S]*pattern: *'?main'?/.test(rel));
  check('release runs only when release.json changes', /changeset:[\s\S]*includes:[\s\S]*'(apps\/[\w-]+\/)?release\.json'/.test(rel));
  check('release uses the ASC integration (no key in the repo)', /app_store_connect: *ChordLoopAPIKey/.test(rel));
  check('release runs scripts/release.py', /scripts\/release\.py/.test(rel));
  check('release emails its result', /email:[\s\S]*jonathanbbiles@gmail\.com/.test(rel));
  check('ios-testflight never builds on a release.json commit', /excludes:[\s\S]*'(apps\/[\w-]+\/)?release\.json'/.test(tf));
  check('ios-testflight emails its result', /email:[\s\S]*jonathanbbiles@gmail\.com/.test(tf));
  check('nothing declares submit_to_app_store: true', !/^\s*submit_to_app_store: *true/m.test(cm));
  if (fs.existsSync(path.join(ROOT, 'release.json'))) {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'release.json'), 'utf8'));
    check(`release.json version ${r.version} matches MARKETING_VERSION`, (cm.match(/MARKETING_VERSION: *"([^"]+)"/) || [])[1] === r.version);
    check('release.json build is a 12-digit build number', /^\d{12}$/.test(String(r.build)));
  }

  console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nverify-release: all checks passed\n');
  process.exit(failed ? 1 : 0);
})();
