import * as http from "node:http";
import { createHash } from "node:crypto";
import { env } from "@telnyx/edge-runtime";

const port = Number(process.env.PORT ?? 8080);
const RATE_LIMIT = 100; // requests per caller per minute
const CACHE_TTL = 300;  // seconds — KV deletes the entry itself

// Route table: path prefix → backend. Point these at your own Telnyx Edge Compute
// functions (on-net `*.telnyxcompute.com`) or the Telnyx API — the gateway adds auth,
// rate-limiting, and caching in front, all on Telnyx primitives (Secrets + KV).
const ROUTES: Record<string, string> = {
  "/get":      "https://httpbin.org", // or another Edge function
  "/anything": "https://httpbin.org", // or another Edge function
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

// Illustrative auth: one shared bearer token from Secrets.
// A real gateway verifies a signed token and extracts the caller identity.
async function callerId(req: http.IncomingMessage): Promise<string | null> {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const expected = await env.SECRETS.get("GATEWAY_KEY");
  return header.slice(7) === expected ? "shared-key-caller" : null;
}

// Fixed-window counter in KV. get-then-put is not atomic: two concurrent
// requests can read the same count, so a burst can slightly exceed the
// limit. Fine for abuse control; for exact limits use a Stateful Actor.
async function rateLimited(caller: string): Promise<boolean> {
  const window = Math.floor(Date.now() / 60_000); // KV keys can't contain ":"
  const key = `rate/${caller}/${window}`;
  const count = Number((await env.GATEWAY_KV.get(key)) ?? "0");
  if (count >= RATE_LIMIT) return true;
  await env.GATEWAY_KV.put(key, String(count + 1), { expirationTtl: 120 });
  return false;
}

function json(res: http.ServerResponse, status: number, body: unknown,
              headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  if (req.url === "/health" || req.url?.startsWith("/health/")) { res.writeHead(200); res.end(); return; }

  // 1. Authenticate
  const caller = await callerId(req);
  if (!caller) return json(res, 401, { error: "unauthorized" });

  // 2. Rate-limit
  if (await rateLimited(caller)) {
    return json(res, 429, { error: "rate limit exceeded" }, { "retry-after": "60" });
  }

  // 3. Route by path prefix
  const path = req.url ?? "/";
  const prefix = Object.keys(ROUTES).find((p) => path.startsWith(p));
  if (!prefix) return json(res, 404, { error: "no route" });

  // 4. Serve cached GETs
  const cacheKey = `cache/${createHash("sha256").update(path).digest("hex")}`;
  if (req.method === "GET") {
    const hit = await env.GATEWAY_KV.get(cacheKey);
    if (hit !== null) {
      res.writeHead(200, { "content-type": "application/json", "x-cache": "hit" });
      res.end(hit);
      return;
    }
  }

  // 5. Forward upstream. Forward only the headers your backends need —
  // copying `host` verbatim breaks upstream TLS and routing.
  const upstream = await fetch(ROUTES[prefix] + path, {
    method: req.method,
    headers: { "content-type": String(req.headers["content-type"] ?? "application/json") },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req),
  });
  const body = await upstream.text();

  // 6. Cache successful GET responses (KV values are capped at 1 MiB)
  if (req.method === "GET" && upstream.ok && Buffer.byteLength(body) < 1_048_576) {
    await env.GATEWAY_KV.put(cacheKey, body, { expirationTtl: CACHE_TTL });
  }

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "x-cache": "miss",
  });
  res.end(body);
}).listen(port);
