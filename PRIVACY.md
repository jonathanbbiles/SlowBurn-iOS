# Slow Burn — what is stored, and what is transmitted

This file is the reference the in-app privacy copy has to match. If they ever
disagree, the code and this file are right and the copy is a bug.

## Stored on the device, never transmitted

All of it lives in `localStorage` under `sb_profile_v2` plus in-memory state.

- Name and pronouns (yours and whatever you entered about your partner)
- Gender, orientation, relationship structure, body-area preferences
- Session counts per stage
- **The free-text private note attached to each reflection**

None of it is published, in any form, encrypted or otherwise. Each phone words
its own copy of the app from its own owner's setup, so none of it needs to
cross. What is never sent cannot be broken.

## Transmitted between two paired phones — end-to-end encrypted

Live pairing is the only feature that uses the network at all. There is no
account, no server of ours, and no analytics. The relay is a public MQTT
broker (`broker.emqx.io`) that carries ciphertext it cannot read.

### The handshake

Per pairing, fresh, nothing persisted:

1. Each phone generates an **ephemeral ECDH P-256 key pair** and publishes
   **only its public key**.
2. Each derives the same shared secret on-device from its own private key and
   the other's public key. **The shared secret is never transmitted**, in any
   form, and never leaves the `E2E` module — it exists as one local variable
   that is zeroed before the function returns.
3. **HKDF-SHA-256** over that secret produces the working keys. The HKDF
   **salt is `SHA-256("slowburn/pairing/v4|salt|" + pairCode)`** and the HKDF
   **info binds the full transcript** — the session id plus both public keys
   in a fixed host-then-guest order. Output, 104 bytes:

   | bytes | use |
   |---|---|
   | 0–31 | AES-256-GCM message key |
   | 32–63 | HMAC key for the host→guest confirmation tag |
   | 64–95 | HMAC key for the guest→host confirmation tag |
   | 96–103 | the 6-character safety word shown on both phones |

4. Each side publishes an **HMAC confirmation tag**. Producing a valid tag
   requires the pair code, because the code is the salt. **Nothing is
   encrypted, sent, decrypted or displayed until both tags verify.**

The pair code itself never goes on the wire. The topic is a *different*
derivation of it (`SHA-256("slowburn/pairing/v4|topic|" + code)`, truncated to
32 hex characters), so seeing the topic tells an observer nothing about the
salt.

### What is actually on the wire

| Topic | Payload | Encrypted? |
|---|---|---|
| `sb4/<sid>/k/<side>` | 65-byte uncompressed P-256 **public** key, base64url | public by design |
| `sb4/<sid>/c/<side>` | 16-byte HMAC confirmation tag, base64url | not secret; useless without the code |
| `sb4/<sid>/m/<side>` | `iv(12) ‖ AES-256-GCM ciphertext ‖ tag(16)`, base64url | **yes** |
| `sb4/<sid>/x/<side>` | **empty** — last will / goodbye | carries nothing to encrypt |

`<side>` is `h` (created the pairing) or `g` (joined it). It identifies neither
person.

Everything that carries meaning is inside `/m/`. Field by field, the entire
plaintext of the link — which only the two phones ever see:

| Field | Meaning | Encrypted |
|---|---|---|
| `v` | protocol version (`4`) | yes |
| `n` | strictly increasing counter, for replay rejection | yes |
| `u` | `0`–`6`: highest stage this phone's owner has confirmed they are ready for | yes |
| `cf` | 8-hex fingerprint of the chip lists, so two app versions can't mismap chips | yes |
| `r` | per stage, the **indexes** (never the text) of the reflection chips chosen: `{g:[…], m:[…]}` | yes |

There is no name, no pronoun, no gender, no orientation, no structure, no
session count and **no note field** in that object — `stateEnvelope()` does not
read `debrief[s].note`, so the written note cannot be sent even by accident.

AES-GCM additional authenticated data is `slowburn/e2e/v4|<sid>|<sender side>`,
so a message cannot be replayed onto the other side's topic. `n` must strictly
increase, so a stale message cannot roll a partner's view of consent backwards.

`retain` is **false** on every publish including the last will. Nothing is left
on the broker; a stranger subscribing after a session ends receives nothing.
Both phones re-announce on a 12-second heartbeat instead.

If `crypto.subtle` is unavailable, **live pairing refuses to run**. There is no
plaintext fallback path in the app.

## The camera

Pairing offers an optional scan of the other phone's pair code. The QR encodes
**the bare pair code and nothing else** — no URL, no origin, no scheme — and
only Slow Burn's own scanner reads it.

- The frame goes `getUserMedia` → a `<video>` → an offscreen `<canvas>` →
  `jsQR`, entirely in the app's own process. **No image is recorded, saved,
  uploaded or kept**, and there is no code path that could send one.
- The stream is stopped the instant a code is read or the sheet is closed;
  `scripts/pairing-qr-test.mjs` asserts zero live camera tracks afterwards.
- A scan is accepted only if it normalises to exactly ten characters of the
  pair-code alphabet, so a stray QR from the world does nothing.
- If the device has no camera API, or permission is refused, the scan button is
  never shown and typing the code — the original path — is unchanged.
- `jsQR` is vendored into `www/vendor/` (Apache-2.0) rather than loaded from a
  CDN, so pairing does not depend on a third-party host and no third party
  learns that you are pairing.

Earlier builds encoded `location.origin + "?pair=<code>"` in that QR, which
inside the native app is `capacitor://localhost/?pair=…`. Nothing could open
it, so scanning did nothing at all; it was a broken affordance, not a leak.

## Purchases, and the keepsake journal

Slow Burn is a **paid app**: one price on the App Store, and everything in it
is included. There is no subscription, no unlock, no paywall and no gated
content — every stage, deck, practice and theme is present for everyone who
installs it. Nothing about the app changes based on what anybody has paid.

There is an optional tip jar (three consumables). It unlocks nothing; the app
is identical whether or not it is ever used. If a tip is bought, that
transaction goes through Apple, device to Apple — we never see payment
details, an Apple ID or a name, and we get no report of who bought anything.
No server of ours is involved and there is no analytics on it.

**The keepsake journal is the one thing that writes reflections to disk**, and
it is **off until you switch it on**. That is a privacy decision, not a
commercial one — the journal is included like everything else. With it on,
each saved reflection, including the free-text note, is appended to
`sb_journal_v1` in the app's own storage on that phone. It is never
transmitted, never part of pairing, and never leaves the device. Switching the
journal off **deletes** what is stored; so does deleting the app.

## Threat model

**What this defends against.**

- *A passive observer of the relay, including its operator.* Sees ciphertext,
  two ephemeral public keys and two short tags. Cannot read the stage pointer
  or the reflection selections. Keys are ephemeral per pairing, so a secret
  recovered later cannot decrypt an earlier session.
- *An active attacker who owns the relay but does not know the pair code.*
  Can inject its own public key, but cannot produce a confirmation tag without
  the code, so the handshake never completes and the victim's phone publishes
  no ciphertext to it at all. (`npm run test:crypto`, case 2.)
- *Replay, reflection and tampering.* Rejected by the counter, the AAD and the
  GCM tag respectively. (Cases 4, 5, 6.)

**What it does not defend against — honestly.**

1. **The relay still learns metadata.** It sees that two anonymous parties are
   exchanging encrypted messages on one hashed topic: when they connect and
   disconnect, the heartbeat rhythm, how many messages, and roughly how large.
   Message size grows a little as reflections accumulate, so a determined
   observer of one session could infer *that* a reflection was recorded —
   never which one. None of it is tied to a person, a device or another
   session. This is inherent to using a relay at all and encryption cannot
   remove it.
2. **An attacker who knows the pair code, and is in position at the moment of
   pairing, can sit in the middle.** It would run two handshakes, one with
   each phone. This is what the **safety word** is for: it is bound to the
   transcript, so an attacker in the middle necessarily produces a *different*
   word on each phone, and two people reading it aloud would see it
   immediately. (`npm run test:crypto`, case 3, shows the words diverging.)
   Comparing it is optional; a couple who never do are relying on the code
   staying between them.
3. **Pair-code entropy is ~45 bits** (10 characters of a 23-character
   alphabet). That is the strength of the *anti-MITM binding*, not of the
   encryption — confidentiality against a passive observer rests on P-256
   ECDH and AES-256-GCM regardless. An offline search over the topic hash
   could recover a code with serious hardware in hours, but a MITM has to be
   in position *during* the few seconds of the handshake, and the code is
   regenerated for every new pairing.
4. **A paired phone does receive its partner's full chip selections**, and
   chooses to display only the overlap — the same as shared-device mode has
   always worked. Someone with the unlocked phone and a debugger could read
   the non-overlapping ones. They cannot read the written note, which is never
   sent. Genuinely hiding the non-overlap would need a private set
   intersection, and with only eight chips per list the candidate space is too
   small for one to mean anything.
5. **The relay is still infrastructure we neither own nor audit.** It can drop
   messages or refuse service. It cannot read them.

`scripts/privacy-wire-audit.mjs` (`npm run audit:privacy`) enforces the wire
format against the real `www/index.html`;
`scripts/e2e-crypto-test.mjs` (`npm run test:crypto`) enforces the threat model
above; and `scripts/pairing-qr-test.mjs` (`npm run test:qr`) drives the real app
in a real browser to prove the pairing QR carries only the pair code and that
the scanner reads it, ignores foreign codes and releases the camera.
`npm test` runs the first two (no browser needed, so it gates every build);
`npm run audit:apple` additionally runs the QR test. **Add a field to the protocol and the audit
fails.** That is the point — fix the protocol, not the test.

## Prior exposure — remediation

Builds up to and including the TestFlight build that shipped the pre-v3
protocol published **name, pronouns, readiness, session counts and reflection
chip selections** to `slowburn/<CODE>/s/<role>` with `retain:true`, under a
6-character guessable code. Retained messages outlive the client, so that data
persisted on the public broker and was readable by anyone subscribing to
`slowburn/#`.

Shipping this fix does not clear it. Run once, from a normal network:

```sh
npm i mqtt
node scripts/purge-legacy-retained.mjs
node scripts/purge-legacy-retained.mjs --verify   # expect "Nothing retained. Clean."
```

This clears what the broker still holds. It cannot un-read what a third party
already copied, so treat the exposure window as real for anyone who paired on
an affected build. The v3 protocol (`sb3/…`) that followed it published only
anonymous single digits and never retained anything, so it left nothing behind.

## App Store privacy posture

"Data Not Collected" still holds. Nothing is collected by us or by a third
party: there is no account, no analytics, no SDK that phones home, and the only
network payload is ciphertext exchanged directly between two paired phones,
which we cannot read, do not receive, and which is not retained anywhere.
StoreKit tips are handled by Apple; we receive no customer data from them.

The camera permission does not change this answer. Camera access is used only
to decode a pair code on-device; no image or derived data is collected,
transmitted or stored, so there is nothing to declare on the nutrition label.
The usage string shown in the iOS permission dialog is set by the build lane —
see `codemagic.yaml`.
