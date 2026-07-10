import * as http from 'node:http';
import { env } from '@telnyx/edge-runtime';

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/health' || req.url?.startsWith('/health/')) { res.writeHead(200); res.end(); return; }

  // env.MY_TELNYX is a pre-authenticated Telnyx client — no API key in your code
  await env.MY_TELNYX.messages.send({
    from: '+13125550100',
    to: '+13125550101',
    text: 'Hello from Edge Compute',
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sent: true }));
});

const port = process.env.PORT || 8080;
server.listen(port, () => { console.log(`Server running on port ${port}`); });
