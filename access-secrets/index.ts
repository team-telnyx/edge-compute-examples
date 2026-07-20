import * as http from 'node:http';
import { env } from '@telnyx/edge-runtime';

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/health' || req.url?.startsWith('/health/')) { res.writeHead(200); res.end(); return; }

  // Typed surface — declared in func.toml, run `telnyx-edge types` so it type-checks
  const key = await env.SECRETS.get('STRIPE_KEY');

  // Environment-variable surface — no declaration needed, works in any language
  const sameKey = process.env.STRIPE_KEY;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    typedSurface: Boolean(key),          // env.SECRETS.get() — type-safe, throws on missing binding
    envVarSurface: Boolean(sameKey),     // process.env — works in any language, silent on missing
    valuesMatch: key === sameKey,        // proves both surfaces read the same secret
  }));
});

const port = process.env.PORT || 8080;
server.listen(port, () => { console.log(`Server running on port ${port}`); });
