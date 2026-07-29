/* ONE-SHOT REMEDIATION — clears personal data left retained on the public
   broker by builds up to and including the TestFlight build that shipped the
   old pairing protocol.
   -----------------------------------------------------------------
   Those builds published name, pronouns, readiness, session counts and
   reflection chip selections to `slowburn/<CODE>/s/<role>` with retain:true.
   A retained MQTT message survives the client disconnecting and is delivered
   to anyone who subscribes afterwards — so that data is still sitting on
   broker.emqx.io today, readable by anyone who subscribes to `slowburn/#`.

   Removing the code from the app does NOT remove it from the broker. The only
   way to clear a retained message is to publish a zero-length retained message
   to the same topic. That is exactly what this does: it subscribes to the old
   namespace, and for every retained message it receives, it blanks that topic.

   RUN IT ONCE, from a normal network:
       npm i mqtt
       node scripts/purge-legacy-retained.mjs
       node scripts/purge-legacy-retained.mjs --verify

   --verify re-subscribes and reports anything still retained. It does not
   write. Run the purge first, then verify; expect "nothing retained".

   Note the honest limit: this clears what the broker still holds. It cannot
   un-read anything a third party already copied. Treat the exposure window as
   real and disclose accordingly.

   The current app does not use this namespace at all and sets retain:false
   everywhere, so nothing it does can be undone by running this. */

import mqtt from "mqtt";

const RELAY = "wss://broker.emqx.io:8084/mqtt";
const LEGACY = "slowburn/#";
const VERIFY = process.argv.includes("--verify");
const QUIET_MS = 8000; // retained messages arrive in a burst on subscribe

const seen = new Map();
let lastMsg = Date.now();

const client = mqtt.connect(RELAY, {
  clientId: "sb_purge_" + Math.random().toString(16).slice(2),
  clean: true,
  connectTimeout: 10000,
});

client.on("connect", () => {
  console.log(`connected — subscribing to ${LEGACY} (${VERIFY ? "VERIFY, read-only" : "PURGE"})`);
  client.subscribe(LEGACY, { qos: 0 }, (err) => {
    if (err) { console.error("subscribe failed:", err.message); process.exit(1); }
  });
});

client.on("message", (topic, payload, packet) => {
  lastMsg = Date.now();
  // Only retained messages are the problem; live traffic from a still-running
  // old client will be re-published by it anyway and dies with its session.
  if (!packet.retain) return;
  if (seen.has(topic)) return;
  seen.set(topic, payload.length);
  if (VERIFY) {
    console.log(`STILL RETAINED  ${topic}  (${payload.length} bytes)`);
  } else {
    client.publish(topic, "", { retain: true, qos: 0 });
    console.log(`cleared  ${topic}  (was ${payload.length} bytes)`);
  }
});

client.on("error", (e) => { console.error("mqtt error:", e.message); });

setInterval(() => {
  if (Date.now() - lastMsg < QUIET_MS) return;
  console.log(
    VERIFY
      ? (seen.size ? `\n${seen.size} topic(s) still retained — re-run the purge.` : "\nNothing retained. Clean.")
      : `\n${seen.size} retained topic(s) cleared. Now run: node scripts/purge-legacy-retained.mjs --verify`
  );
  client.end(true, () => process.exit(0));
}, 1000);
