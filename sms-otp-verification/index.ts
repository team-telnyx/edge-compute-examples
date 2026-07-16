import * as http from "node:http";
import { randomInt, timingSafeEqual } from "node:crypto";
import { env } from "@telnyx/edge-runtime";

const port = Number(process.env.PORT ?? 8080);

const FROM = "+13125550100"; // ⚠️ Replace with a Telnyx number you own before deploying.
const CODE_TTL = 300;        // codes live 5 minutes
const COOLDOWN = 30;         // min seconds between sends to one number
// Hard cap on how long messages.send() may run. MUST be < COOLDOWN * 1000 so
// the in-flight reservation cannot expire while a send is still outstanding —
// otherwise a stale success can land after a concurrent /send has already
// overwritten otp/<num>. maxRetries: 0 combined with this ceiling means one
// attempt, one deadline, no post-cooldown zombies.
const SEND_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 5;      // wrong guesses before the code is burned

interface Challenge { code: string; attempts: number; expiresAt: number }

// KV keys allow only a-zA-Z0-9-_/=. — strip the "+" from E.164.
const digits = (e164: string) => e164.replace(/[^0-9]/g, "");
const otpKey = (e164: string) => `otp/${digits(e164)}`;
const coolKey = (e164: string) => `cool/${digits(e164)}`;

// Reject after `timeoutMs` so a bodyless POST (no Content-Length, no `end`
// event) can't wedge the async handler forever and leave the container
// unresponsive to every subsequent request.
function readBody(req: http.IncomingMessage, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = "";
    const timer = setTimeout(
      () => reject(new Error("body read timeout")),
      timeoutMs,
    );
    req.on("data", (c) => (b += c));
    req.on("end", () => { clearTimeout(timer); resolve(b); });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
// Compare without leaking length/position through timing.
function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

http.createServer(async (req, res) => {
  if (req.url === "/health" || req.url?.startsWith("/health/")) { res.writeHead(200); res.end(); return; }
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  // This is a service *your* apps call, deployed at the edge for low latency
  // everywhere. Authenticate the caller with a shared bearer secret.
  const apiKey = await env.SECRETS.get("APP_API_KEY");
  if (req.headers.authorization !== `Bearer ${apiKey}`) {
    return json(res, 401, { error: "unauthorized" });
  }

  let input: { phone_number?: string; code?: string };
  try { input = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { error: "invalid JSON" }); }

  const phone = input.phone_number;
  if (!phone || !/^\+[1-9]\d{6,14}$/.test(phone)) {
    return json(res, 400, { error: "phone_number must be E.164, e.g. +13125550100" });
  }
  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    // POST /send — mint a code, text it, remember it with a TTL.
    if (url.pathname === "/send") {
      if (await env.OTP.get(coolKey(phone))) {
        return json(res, 429, { error: "code already sent, try again shortly" });
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const challenge: Challenge = { code, attempts: 0, expiresAt: Date.now() + CODE_TTL * 1000 };

      // Reserve the cooldown BEFORE the slow messages.send() call, so
      // concurrent /send requests for the same phone within the same
      // in-flight window get 429'd instead of each racing past the cooldown
      // check and sending their own paid SMS.
      //
      // Do NOT write otp/<num> yet. Earlier revisions wrote it here and tried
      // to compare-and-delete on failure, but env.OTP.get is not a real CAS:
      // NATS KV reads can lag writes across regions, so a failed send in one
      // region could read its own stale challenge, pass the equality guard,
      // and wipe a newer, valid challenge that a later /send in another
      // region wrote and successfully sent. Move the OTP write after send
      // succeeds and there is no delete-on-failure branch to race.
      await env.OTP.put(coolKey(phone), "1", { expirationTtl: COOLDOWN });
      try {
        // Cap the send at SEND_TIMEOUT_MS (< COOLDOWN) and disable SDK retries.
        // Prior versions let messages.send() run unbounded, which meant a slow
        // Telnyx response or SDK retry chain could outlive the cooldown
        // reservation: cool/<num> expires → concurrent /send lands and writes
        // otp/<num> = challenge_B → our original slow send finally returns
        // success → we overwrite otp/<num> = challenge_A even though the user
        // has code_B in their inbox. Bounding the send so it cannot outlive
        // the reservation kills that timeline.
        await env.MY_TELNYX.messages.send({
          from: FROM, to: phone, text: `Your verification code is ${code}. It expires in 5 minutes.`,
        }, { maxRetries: 0, timeout: SEND_TIMEOUT_MS });
      } catch (err) {
        // Classify: 4xx (except 408/409/429) = Telnyx definitively rejected
        // (bad number, auth, disabled profile). Clear the cooldown so the
        // caller can retry immediately with a corrected request. No otp key
        // was ever written, so nothing else to clean up.
        //
        // 408 / 409 / 429 / 5xx / connection errors = AMBIGUOUS. The Telnyx
        // Node SDK's own retry policy treats these as retryable in
        // node_modules/telnyx/client.js shouldRetry(). Telnyx may have
        // enqueued the SMS before the client saw an error, so the code could
        // still land. We KEEP the cooldown to block send hammering during
        // the in-flight window. Because otp/<num> was never written, /verify
        // returns 410 either way — the user has to wait out COOLDOWN and
        // request a fresh code. That is deliberately conservative: better to
        // waste one SMS than to certify a code we cannot prove reached the
        // user.
        const status = (err as { status?: number })?.status;
        const definitivelyRejected =
          typeof status === "number" &&
          status >= 400 &&
          status < 500 &&
          status !== 408 &&
          status !== 409 &&
          status !== 429;

        if (definitivelyRejected) {
          await env.OTP.delete(coolKey(phone));
        }
        throw err;
      }

      // Send succeeded within SEND_TIMEOUT_MS, so cool/<num> is guaranteed
      // still live (SEND_TIMEOUT_MS < COOLDOWN * 1000). That means no
      // concurrent /send could have passed the cooldown check yet, and
      // otp/<num> either does not exist or holds an older-generation
      // challenge whose SMS never landed — either way it is safe to
      // overwrite. Refresh cool/<num> to the full COOLDOWN so the ceiling
      // starts at commit time, not at reservation time.
      await env.OTP.put(otpKey(phone), JSON.stringify(challenge), { expirationTtl: CODE_TTL });
      await env.OTP.put(coolKey(phone), "1", { expirationTtl: COOLDOWN });

      return json(res, 200, { status: "sent", expires_in: CODE_TTL });
    }

    // POST /verify — check the guess, consume on success, lock out after N tries.
    if (url.pathname === "/verify") {
      if (typeof input.code !== "string") return json(res, 400, { error: "code required" });

      const challenge = await env.OTP.get<Challenge>(otpKey(phone), { type: "json" });
      // KV usually evicts on TTL, but a re-put below could outlive the window —
      // the absolute expiresAt is the source of truth for "still valid".
      if (!challenge || Date.now() > challenge.expiresAt) {
        await env.OTP.delete(otpKey(phone));
        return json(res, 410, { error: "no active code — request a new one" });
      }

      if (sameCode(challenge.code, input.code)) {
        await env.OTP.delete(otpKey(phone)); // single-use
        return json(res, 200, { verified: true });
      }

      // Wrong guess — count it, burn the code once the limit is hit.
      const attempts = challenge.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await env.OTP.delete(otpKey(phone));
        return json(res, 429, { verified: false, error: "too many attempts — request a new code" });
      }
      // Re-put with the *remaining* lifetime so wrong guesses never extend the window.
      const ttl = Math.max(1, Math.ceil((challenge.expiresAt - Date.now()) / 1000));
      await env.OTP.put(otpKey(phone), JSON.stringify({ ...challenge, attempts }), {
        expirationTtl: ttl,
      });
      return json(res, 401, { verified: false, attempts_left: MAX_ATTEMPTS - attempts });
    }

    return json(res, 404, { error: "POST /send or POST /verify" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: "internal error" });
  }
}).listen(port);
