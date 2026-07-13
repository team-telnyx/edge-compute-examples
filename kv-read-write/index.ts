import * as http from 'node:http';
import { env } from '@telnyx/edge-runtime';   // ≥ 0.2.2 — earlier versions silently ignore expirationTtl

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/health' || req.url?.startsWith('/health/')) { res.writeHead(200); res.end(); return; }

  // Keys ≤ 256 chars from a-z A-Z 0-9 - _ / = . — colons rejected, use '/' (user/123, not user:123).
  // Values ≤ 1 MiB. Last-write-wins — for counters/coordination use Stateful Actors instead.
  await env.MY_KV.put('user/123', JSON.stringify({ name: 'Alice' }));

  const user = await env.MY_KV.get<{ name: string }>('user/123', { type: 'json' });  // null if missing

  await env.MY_KV.put('otp/123', '482913', { expirationTtl: 60 });  // server-side expiry after ~60 s

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ user }));
});

const port = process.env.PORT || 8080;
server.listen(port, () => { console.log(`Server running on port ${port}`); });
