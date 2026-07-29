# SlowBurn-iOS

Slow Burn — a guided intimacy program, solo or with a partner. Single-file web
app (`www/index.html`) wrapped natively with Capacitor.

## Privacy

Everything a person enters stays on their device. The only network feature is
live pairing, and it transmits exactly two things: whether a phone is online,
and a single digit for the stage its owner has confirmed they are ready for.
Nothing is retained on the relay.

**[PRIVACY.md](PRIVACY.md) is the reference the in-app copy must match.** Read
it before changing anything in the pairing code or any privacy wording.

```sh
npm i                  # includes jsdom for the audit
npm run audit:privacy  # fails if anything personal reaches the wire
```

`scripts/purge-legacy-retained.mjs` is a one-shot cleanup for data left retained
on the public broker by earlier builds — see PRIVACY.md.
