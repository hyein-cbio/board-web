import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { pipeline } from 'node:stream/promises';

const UI = new URL('../ui/', import.meta.url);
const CLASSIC = '/classic';
const TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const FORWARDED = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'];
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: data: blob:",
  "media-src blob:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const TLS_HANDSHAKE = 0x16;
const FIRST_BYTE_TIMEOUT_MS = 10_000;

/**
 * Board Web: its own UI at `/`, the Inspector's API at `/board`, and the Inspector's own UI at `/classic`.
 * The Inspector acts as the signed-in user, so this server is its front door and keeps the same rules:
 * loopback names only (no DNS rebinding), nothing a proxy forwarded, and writes only from this origin.
 * The per-run token still comes from the Inspector and still has to be sent by the page.
 * With `tls` ({ cert, key }), the same port answers https as well as http.
 */
export function createBoardWeb({ inspectorPort, tls = null }) {
  const inspector = `127.0.0.1:${inspectorPort}`;
  const plain = createServer(handle);
  if (!tls) return plain;

  // A TLS connection opens with a handshake record; anything else on the port is plain HTTP.
  const secure = createSecureServer(tls, handle);
  const server = createTcpServer((socket) => {
    const drop = () => socket.destroy();
    socket.on('error', drop);
    socket.setTimeout(FIRST_BYTE_TIMEOUT_MS, drop);
    socket.once('data', (head) => {
      socket.off('error', drop);
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(head);
      (head[0] === TLS_HANDSHAKE ? secure : plain).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  server.closeAllConnections = () => {
    plain.closeAllConnections();
    secure.closeAllConnections();
  };
  return server;

  function handle(req, res) {
    const port = req.socket.localPort;
    const scheme = req.socket.encrypted ? 'https' : 'http';
    const host = String(req.headers.host ?? '').toLowerCase();
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) ||
        FORWARDED.some((header) => header in req.headers)) {
      return send(res, 421, `Open ${scheme}://localhost:${port} or ${scheme}://127.0.0.1:${port} directly.`);
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return send(res, 400, 'Invalid request target.');

    const reading = req.method === 'GET' || req.method === 'HEAD';
    if (!reading && req.headers.origin !== `${scheme}://${host}`) return send(res, 403, 'Writes must come from this page.');

    const { pathname } = new URL(req.url, 'http://board-web');
    if (pathname === '/board' || pathname.startsWith('/board/')) return proxy(req, res, req.url);
    if (pathname === CLASSIC || pathname.startsWith(`${CLASSIC}/`)) {
      const rest = req.url.slice(CLASSIC.length);
      return proxy(req, res, rest.startsWith('/') ? rest : `/${rest}`, true);
    }
    if (!reading) return send(res, 405, 'Method not allowed.');
    if (pathname.startsWith('/assets/')) return void asset(res, pathname.slice(8)).catch(() => send(res, 500, 'Error.'));
    return void page(res).catch(() => send(res, 500, 'Error.'));
  }

  async function page(res) {
    const template = await readFile(new URL('index.html', UI), 'utf8');
    const token = await fetch(`http://${inspector}/`, { signal: AbortSignal.timeout(5000) })
      .then((response) => response.text())
      .then((html) => html.match(/<meta name="inspect-token" content="([^"]*)">/)?.[1] ?? '')
      .catch(() => '');
    const html = template.replaceAll('%TOKEN%', () => attribute(token))
      .replaceAll('%INSPECTOR%', () => String(inspectorPort));
    res.writeHead(token ? 200 : 503, {
      ...SECURITY,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'cache-control': 'no-store',
    }).end(html);
  }

  function proxy(req, res, path, classic = false) {
    const headers = endToEnd(req.headers);
    headers.host = inspector;
    if (headers.origin) headers.origin = `http://${inspector}`;
    delete headers.referer;
    delete headers['accept-encoding'];

    const upstream = request({ hostname: '127.0.0.1', port: inspectorPort, path, method: req.method, headers },
      (incoming) => void relay(res, incoming, classic && req.method === 'GET').catch(() => fail(res, 'Inspector response interrupted.')));
    upstream.on('error', () => fail(res, `Cannot reach the Inspector on 127.0.0.1:${inspectorPort}.`));
    req.on('error', () => upstream.destroy());
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }
}

/** Streams the Inspector's answer through; under `/classic`, its page is told it lives there. */
async function relay(res, incoming, classic) {
  const headers = endToEnd(incoming.headers);
  if (!classic || incoming.statusCode !== 200 || !/^text\/html(?:;|$)/i.test(headers['content-type'] ?? '')) {
    res.writeHead(incoming.statusCode, headers);
    return pipeline(incoming, res);
  }
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const html = Buffer.concat(chunks).toString('utf8')
    .replace('<meta name="inspect-base" content="">', `<meta name="inspect-base" content="${CLASSIC}">`)
    .replace('<script type="module" src="/app.js', `<script type="module" src="${CLASSIC}/app.js`);
  delete headers.etag;
  headers['content-length'] = Buffer.byteLength(html);
  res.writeHead(200, headers).end(html);
}

async function asset(res, name) {
  const type = TYPES[/^[a-z0-9-]+\.([a-z]+)$/.exec(name)?.[1]];
  const body = type && await readFile(new URL(name, UI)).catch(() => null);
  if (!body) return send(res, 404, 'Not found.');
  res.writeHead(200, { ...SECURITY, 'content-type': type, 'cache-control': 'no-cache' }).end(body);
}

function endToEnd(headers) {
  const copy = { ...headers };
  const named = String(copy.connection ?? '').toLowerCase().split(',').map((name) => name.trim());
  for (const header of [...HOP_BY_HOP, ...named]) delete copy[header];
  return copy;
}

function fail(res, text) {
  if (!res.headersSent && !res.destroyed) send(res, 502, text);
  else res.destroy();
}

function send(res, status, text) {
  res.writeHead(status, { ...SECURITY, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    .end(`${text}\n`);
}

const attribute = (value) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
