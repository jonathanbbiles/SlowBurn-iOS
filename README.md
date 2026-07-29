# SlowBurn-iOS

Slow Burn — a guided intimacy program, solo or with a partner. Single-file web
app (`www/index.html`) wrapped natively with Capacitor.

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
