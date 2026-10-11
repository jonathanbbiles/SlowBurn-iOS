/* Optional: let headless Chrome load the app's web fonts and CDN scripts through curl.

   Some sandboxes (Claude Code cloud sessions) re-terminate TLS at an egress proxy whose
   CA curl trusts (via the system bundle) but Chrome's own certificate store does not.
   Chrome then renders the app with fallback fonts and no QR library — useless for
   App Store screenshots. With CURL_FETCH=1 every https:// request the page makes is
   fetched by curl instead, with full certificate verification, and handed back to the
   page. On a normal machine leave it unset: Chrome fetches everything itself.

   Responses are cached per run, so 80 renders cost one download each. */
import { execFileSync } from "node:child_process";

const cache = new Map();
const TYPES = { ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };

function fetchViaCurl(url) {
  if (cache.has(url)) return cache.get(url);
  let res;
  try {
    const body = execFileSync("curl", ["-sSfL", "--max-time", "30", "-A",
      // Google Fonts serves woff2 only to a browser it recognises.
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      url], { maxBuffer: 32 * 1024 * 1024 });
    const ext = (url.split("?")[0].match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
    const type = url.includes("fonts.googleapis.com/css") ? "text/css" : TYPES[ext] || "application/octet-stream";
    res = { status: 200, body, contentType: type, headers: { "access-control-allow-origin": "*" } };
  } catch (e) {
    res = null;
  }
  cache.set(url, res);
  return res;
}

/** Call once per puppeteer page, before navigating. No-op unless CURL_FETCH=1. */
export async function routeThroughCurl(page) {
  if (process.env.CURL_FETCH !== "1") return;
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith("https://")) return req.continue();
    const r = fetchViaCurl(url);
    return r ? req.respond(r) : req.abort();
  });
}
