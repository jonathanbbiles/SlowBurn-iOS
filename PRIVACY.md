# Slow Burn — what is stored, and what is transmitted

This file is the reference the in-app privacy copy has to match. If they ever
disagree, the code and this file are right and the copy is a bug.

## Stored on the device, never transmitted

All of it lives in `localStorage` under `sb_profile_v2` plus in-memory state.
None of it is published, in any form, encrypted or otherwise.

- Name and pronouns (yours and whatever you entered about your partner)
- Gender, orientation, relationship structure, body-area preferences
- Which stages you have confirmed you are ready for
- Session counts per stage
- Reflection chip selections ("what felt good", "what you'd welcome more of")
- The free-text private note attached to each reflection

## Transmitted between two paired phones

Live pairing is the only feature that uses the network at all. The complete
protocol is two topics carrying one character each:

| Topic | Payload | Meaning |
|---|---|---|
| `sb3/<sessionId>/p/<side>` | `1` / `0` | this phone is currently connected |
| `sb3/<sessionId>/u/<side>` | `0`–`6` | highest stage this phone's owner has confirmed they are ready for |

- `<side>` is `h` (created the pairing) or `g` (joined it). It identifies
  neither person.
- `<sessionId>` is `SHA-256("slowburn/pairing/v3|" + pairCode)`, truncated to
  32 hex characters. The pair code itself never goes on the wire, and the topic
  cannot be derived without it.
- `retain` is **false** on every publish including the last-will. Nothing is
  left on the broker; a stranger subscribing after a session ends receives
  nothing. Because there is no retained state to read on arrival, both phones
  re-announce on a 12-second heartbeat instead.
- Payloads are bare single characters, not JSON. There is no object for a field
  to creep back into.

The stage number is what makes the consent gate work: stage N+1 opens only when
both people have privately confirmed, which no phone can know unless the other
tells it. One integer is the smallest signal that carries that.

`scripts/privacy-wire-audit.mjs` (`npm run audit:privacy`) enforces all of the
above against the real `www/index.html`. **Add a field to the protocol and that
test fails.**

## Honest limitations

1. **The relay is a public broker** (`broker.emqx.io`), unauthenticated, and
   anyone may subscribe to `sb3/#`. What they would collect is anonymous stage
   integers and connect/disconnect blips, unlinkable to any person, device or
   other session. That is an acceptable exposure for this payload — it would
   *not* have been for the old one. Hashing the topic means an observer also
   cannot enumerate or target a particular couple without their pair code.
2. **It is still behavioural metadata.** A dedicated observer of the whole
   namespace could count concurrent sessions and see anonymous pacing patterns.
   Nothing ties those to a person, but it is not zero.
3. **The correct long-term answer is a private authenticated backend** — an
   account-less pairing service with per-session credentials and TLS to a host
   under our control, so the coordination signal is not on infrastructure we
   neither own nor audit. That is a real piece of work (hosting, uptime, a
   privacy policy that covers a server we operate) and is not a prerequisite
   for the current build being truthful. It is the next step, not a pending
   defect.

## Prior exposure — remediation

Builds up to and including the TestFlight build that shipped the previous
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
an affected build.

## App Store privacy posture

"Data Not Collected" still holds. Nothing is collected by us or by a third
party: there is no account, no analytics, no SDK that phones home, and the only
network payload is an anonymous integer that is not an identifier, not linked to
a user, and not retained anywhere. StoreKit tips are handled by Apple; we
receive no customer data from them.
