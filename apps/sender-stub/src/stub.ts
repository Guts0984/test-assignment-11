import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type Mode = 'ok' | 'error' | 'hang';
export type Received = {
  seq: number;
  at: string;
  webhookId: string;
  timestamp: string;
  signature: string;
  signatureValid: boolean;
  body: unknown;
  rawBody: string;
  mode: Mode;
  answered: number | 'hung';
};

export type StubState = { mode: Mode; received: Received[]; counter: number };

/** Independent implementation of the documented scheme: HMAC-SHA256(secret, `${id}.${timestamp}.${rawBody}`). */
export function verifySignature(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected = `v1=${createHmac('sha256', secret).update(`${id}.${timestamp}.${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const readBody = (req: IncomingMessage, limit = 1_000_000): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function page(state: StubState): string {
  const rows = [...state.received]
    .reverse()
    .map(
      (r) =>
        `<tr class="${r.signatureValid ? '' : 'bad'}"><td>${r.seq}</td><td>${esc(r.at)}</td><td>${esc(String((r.body as { event?: string })?.event ?? ''))}</td><td>${esc(String((r.body as { number?: string })?.number ?? ''))}</td><td><code>${esc(r.webhookId)}</code></td><td>${r.signatureValid ? 'valid' : 'INVALID'}</td><td>${esc(String(r.answered))}</td></tr>`,
    );
  const btn = (m: Mode, label: string) =>
    `<button data-mode="${m}" ${state.mode === m ? 'aria-pressed="true" class="on"' : 'aria-pressed="false"'}>${label}</button>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sender stub</title>
<style>body{font:15px system-ui;margin:24px;max-width:1000px}button{padding:8px 14px;margin-right:6px;border:1px solid #888;border-radius:6px;background:#fff;cursor:pointer}button.on{background:#111;color:#fff}
table{border-collapse:collapse;width:100%;margin-top:16px}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;font-size:13px}tr.bad{background:#fee}code{font-size:12px}</style>
<h1>Sender stub</h1>
<p>Receives webhook notifications at <code>POST /hook</code>. Response mode:</p>
<p id="modes">${btn('ok', 'Answer 200')}${btn('error', 'Answer 500')}${btn('hang', 'Do not answer')}
<button id="reset">Clear</button></p>
<p>Mode: <strong id="mode">${state.mode}</strong>. Received: <strong id="count">${state.received.length}</strong></p>
<table><thead><tr><th>#</th><th>Time</th><th>Event</th><th>Delivery</th><th>Webhook-Id</th><th>Signature</th><th>Answered</th></tr></thead><tbody id="rows">${rows.join('')}</tbody></table>
<script>
document.getElementById('modes').addEventListener('click', async (e) => { const m = e.target.dataset && e.target.dataset.mode; if (!m) return; await fetch('/api/mode', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:m})}); location.reload(); });
document.getElementById('reset').addEventListener('click', async () => { await fetch('/api/reset', {method:'POST'}); location.reload(); });
setInterval(async () => { const r = await (await fetch('/api/received')).json(); if (r.received.length !== Number(document.getElementById('count').textContent)) location.reload(); }, 2000);
</script></html>`;
}

export type StubOptions = { secret: string; port?: number; host?: string };
export type RunningStub = {
  server: Server;
  state: StubState;
  url: string;
  close: () => Promise<void>;
};

/** A tiny functional receiver: records notifications, verifies signatures, can fail or hang on demand. */
export async function createStub(opts: StubOptions): Promise<RunningStub> {
  const state: StubState = { mode: 'ok', received: [], counter: 0 };
  const hung = new Set<ServerResponse>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/hook') {
        const raw = await readBody(req);
        const id = String(req.headers['webhook-id'] ?? '');
        const ts = String(req.headers['webhook-timestamp'] ?? '');
        const sig = String(req.headers['webhook-signature'] ?? '');
        let body: unknown = null;
        try {
          body = JSON.parse(raw);
        } catch {
          /* keep null */
        }
        const mode = state.mode;
        const rec: Received = {
          seq: ++state.counter,
          at: new Date().toISOString(),
          webhookId: id,
          timestamp: ts,
          signature: sig,
          signatureValid: !!id && !!ts && verifySignature(opts.secret, id, ts, raw, sig),
          body,
          rawBody: raw,
          mode,
          answered: mode === 'hang' ? 'hung' : mode === 'error' ? 500 : 200,
        };
        state.received.push(rec);
        if (mode === 'hang') {
          hung.add(res);
          res.on('close', () => hung.delete(res));
          return; // never answers
        }
        return json(res, mode === 'error' ? 500 : 200, { ok: mode === 'ok' });
      }
      if (req.method === 'GET' && url.pathname === '/api/received')
        return json(res, 200, { mode: state.mode, received: state.received });
      if (req.method === 'POST' && url.pathname === '/api/mode') {
        const m = (JSON.parse((await readBody(req)) || '{}') as { mode?: string }).mode;
        if (m !== 'ok' && m !== 'error' && m !== 'hang')
          return json(res, 400, { error: 'mode must be ok, error or hang' });
        state.mode = m;
        if (m !== 'hang') for (const r of hung) r.destroy();
        return json(res, 200, { mode: state.mode });
      }
      if (req.method === 'POST' && url.pathname === '/api/reset') {
        state.received.length = 0;
        state.counter = 0;
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/health')
        return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return void res.end(page(state));
      }
      json(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) json(res, 400, { error: 'bad request' });
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve),
  );
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
  return {
    server,
    state,
    url: `http://${opts.host === '0.0.0.0' || !opts.host ? '127.0.0.1' : opts.host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of hung) r.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
