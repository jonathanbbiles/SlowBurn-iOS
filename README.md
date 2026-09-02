# SlowBurn-iOS

Slow Burn — a guided intimacy program, solo or with a partner. Single-file web
app (`www/index.html`) wrapped natively with Capacitor.

## The App Store listing

The listing is in the repo, not just in App Store Connect. `store/store-listing.md` is the
prose source of truth; `fastlane/metadata/` is the same content in the form `fastlane deliver`
uploads, and `fastlane/screenshots/en-US/` holds the twelve iPhone screenshots
(6.9" 1290x2796 and 6.5" 1284x2778 — this is an iPhone-only app, so there are no iPad shots).

```
scripts/cm-build.sh --watch                              # read-only check, writes nothing
scripts/cm-build.sh --env ASC_LISTING_MODE=push --watch  # upload the listing, do not submit
```

Every push to `main` runs the read-only mode, which proves the App Store Connect key still
works without touching the live listing. Writing requires the explicit override above, and the
lane refuses to write at all unless Apple reports a version in an editable state — so it cannot
disturb a review in flight.

Submitting is a separate step (`scripts/asc-submit.sh`, via `--submit`), because Slow Burn's
review submission must include the Small Tip in-app purchase alongside the version, and
`fastlane deliver` cannot attach one. See `store/1.1-remediation-notes.md`.

## Privacy

Everything a person enters stays on their device. The only network feature is
live pairing between two phones, and it is **end-to-end encrypted**: the two
phones perform an ephemeral ECDH key exchange over the relay, publishing only
their public keys, authenticate it with the pair code (which never travels),
and encrypt everything afterwards with AES-256-GCM. The relay sees ciphertext.

What crosses, encrypted: the stage each person has confirmed they are ready
for, and the indexes of the reflection chips they chose, so the app can show
what you both welcome more of. What never crosses at all: names, pronouns,
gender, orientation, relationship structure, session counts, and every written
private note.

**[PRIVACY.md](PRIVACY.md) is the reference the in-app copy must match**, and
it documents the threat model — including what the relay can still infer.
Read it before changing anything in the pairing code or any privacy wording.

```sh
npm i                  # includes jsdom for the tests
npm test               # both of the below
npm run audit:privacy  # fails if anything readable reaches the wire
npm run test:crypto    # fails if the handshake stops resisting a hostile relay
```

Both tests boot two real phones (`www/index.html` in jsdom) on an in-process
broker that records every byte, and assert against that recording.

`scripts/purge-legacy-retained.mjs` is a one-shot cleanup for data left retained
on the public broker by earlier builds — see PRIVACY.md.
