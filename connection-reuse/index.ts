import * as http from 'node:http';

// Module level — runs once per container, shared by every request it serves.
// Module state is per-container and lost on scale-down or redeploy: treat it as
// a cache, not a store. For durable data use KV; for consistency use Stateful Actors.
const localCache = new Map<string, string>();

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/health' || req.url?.startsWith('/health/')) { res.writeHead(200); res.end(); return; }

  const key = req.url ?? '/';
  let body = localCache.get(key);
  if (body === undefined) {
    const upstream = await fetch('https://httpbin.org/uuid');
    body = await upstream.text();
    localCache.set(key, body);   // reused by later requests on this container
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ cachedKeys: localCache.size, body }));
});

const port = process.env.PORT || 8080;
server.listen(port, () => { console.log(`Server running on port ${port}`); });
