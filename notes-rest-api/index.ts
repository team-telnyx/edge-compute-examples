import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { env } from "@telnyx/edge-runtime";

interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

const port = Number(process.env.PORT ?? 8080);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  // Health fast-path — the platform probes this; keep it first and cheap
  if (req.url === "/health" || req.url?.startsWith("/health/")) {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/notes(?:\/([A-Za-z0-9-]+))?$/);
  if (!match) return json(res, 404, { error: "not found" });
  const id = match[1];

  try {
    // GET /notes — list. KV list() returns key metadata, not values, and KV has
    // no batch get: this is one read per note. Fine at tutorial scale; for large
    // collections return the key names and fetch on demand. First page only
    // (up to 1000 keys) — pass { cursor } to paginate.
    if (!id && req.method === "GET") {
      const { keys } = await env.NOTES.list({ prefix: "note/" });
      const notes = await Promise.all(
        keys.map((k) => env.NOTES.get<Note>(k.name, { type: "json" })),
      );
      return json(res, 200, { notes: notes.filter(Boolean) });
    }

    // POST /notes — create
    if (!id && req.method === "POST") {
      let input: { title?: string; body?: string };
      try {
        input = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      if (typeof input.title !== "string") {
        return json(res, 400, { error: "title (string) required" });
      }
      const note: Note = {
        id: randomUUID(),
        title: input.title,
        body: input.body ?? "",
        updatedAt: new Date().toISOString(),
      };
      await env.NOTES.put(`note/${note.id}`, JSON.stringify(note));
      return json(res, 201, note);
    }

    // GET /notes/:id
    if (id && req.method === "GET") {
      const note = await env.NOTES.get<Note>(`note/${id}`, { type: "json" });
      return note ? json(res, 200, note) : json(res, 404, { error: "not found" });
    }

    // DELETE /notes/:id — idempotent; deleting a missing key is not an error
    if (id && req.method === "DELETE") {
      await env.NOTES.delete(`note/${id}`);
      return json(res, 200, { deleted: true });
    }

    return json(res, 405, { error: "method not allowed" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: "internal error" });
  }
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
