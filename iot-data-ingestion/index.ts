import * as http from "node:http";
import { env } from "@telnyx/edge-runtime";

const port = Number(process.env.PORT ?? 8080);

interface Reading {
  sensor_type: string;
  value: number;
  timestamp: string;
}

function isReading(d: any): d is Reading {
  return typeof d?.sensor_type === "string" &&
         typeof d?.value === "number" &&
         typeof d?.timestamp === "string";
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  if (req.url === "/health" || req.url?.startsWith("/health/")) { res.writeHead(200); res.end(); return; }
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

  // 1. Authenticate the device — a shared token from Secrets.
  // Per-device credentials would live in KV, keyed by device ID.
  const token = await env.SECRETS.get("DEVICE_TOKEN");
  if (req.headers.authorization !== `Bearer ${token}`) {
    return json(res, 401, { error: "unauthorized" });
  }

  // 2. Validate
  let reading: Reading;
  try {
    const parsed = JSON.parse(await readBody(req));
    if (!isReading(parsed)) throw new Error("shape");
    reading = parsed;
  } catch {
    return json(res, 400, { error: "invalid reading" });
  }

  // 3. Enrich. Sanitize the device ID — it becomes part of a KV key,
  // and KV keys allow only a-zA-Z0-9-_/=.
  const deviceId = String(req.headers["x-device-id"] ?? "unknown")
    .replace(/[^a-zA-Z0-9\-_]/g, "-");
  const enriched = {
    ...reading,
    device_id: deviceId,
    received_at: new Date().toISOString(),
  };

  // 4. Keep a last-seen snapshot per device. The TTL means a device
  // that stops reporting disappears from KV after a day — no sweeper.
  await env.DEVICES.put(`last/${deviceId}`, JSON.stringify(enriched), {
    expirationTtl: 86_400,
  });

  // 5. Archive the reading durably in Telnyx Cloud Storage through the env.ARCHIVE
  // binding — no S3 keys in your code, no third-party data lake. Partition by
  // device and day so the whole fleet's history is easy to list/scan later. The
  // function keeps nothing, so a failed write is data loss — tell the device to retry.
  const day = enriched.received_at.slice(0, 10); // YYYY-MM-DD
  const objectKey = `readings/${deviceId}/${day}/${enriched.received_at}.json`;
  try {
    await env.ARCHIVE.put(objectKey, JSON.stringify(enriched), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch {
    return json(res, 502, { error: "archive failed, retry" });
  }

  json(res, 202, { received: true, archived: objectKey });
}).listen(port);
