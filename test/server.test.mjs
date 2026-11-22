import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBoardWeb } from '../lib/server.mjs';

const shell = '<html><head><meta name="inspect-token" content="fixture-token">' +
  '<meta name="inspect-base" content=""></head><body><div id="root"></div>' +
  '<script type="module" src="/app.js?v=0.54.0"></script></body></html>';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return server.address().port;
}

function call(port, path, { method = 'GET', headers = {}, body, ca } = {}) {
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port, path, method, headers: { host: `${ca ? 'localhost' : '127.0.0.1'}:${port}`, ...headers } };
    const req = (ca ? secureRequest : request)({ ...options, ...(ca ? { ca, servername: 'localhost', agent: false } : {}) }, async (res) => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function setup(t, tls) {
  const seen = [];
  const inspectorPort = await listen(t, createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url.startsWith('/board')) {
      return res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, url: req.url }));
    }
    if (req.url.startsWith('/app.js')) return res.writeHead(200, { 'content-type': 'text/javascript' }).end('/* classic */');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'", etag: '"x"' }).end(shell);
  }));
  const port = await listen(t, createBoardWeb({ inspectorPort, tls }));
  return { port, inspectorPort, seen };
}

function certificate(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-web-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return { cert: readFileSync(join(dir, 'cert.pem')), key: readFileSync(join(dir, 'key.pem')) };
}

test('serves its own page with the Inspector token, under a strict CSP', async (t) => {
  const { port } = await setup(t);
  for (const path of ['/', '/c/general', '/c/dev/api/t/msg_1?q=x', '/tasks']) {
    const page = await call(port, path);
    assert.equal(page.status, 200, path);
    assert.match(page.text, /<meta name="board-token" content="fixture-token">/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-inline/);
    assert.equal(page.headers['cache-control'], 'no-store');
  }
  const local = await call(port, '/', { headers: { host: `localhost:${port}` } });
  assert.equal(local.status, 200);
});

test('says so when the Inspector is not running', async (t) => {
  const idle = createServer();
  const inspectorPort = await listen(t, idle);
  await new Promise((resolve) => idle.close(resolve));
  const port = await listen(t, createBoardWeb({ inspectorPort }));
  const page = await call(port, '/');
  assert.equal(page.status, 503);
  assert.match(page.text, /<meta name="board-token" content="">/);
  assert.equal((await call(port, '/board/me')).status, 502);
});

test('serves only its own assets', async (t) => {
  const { port } = await setup(t);
  const app = await call(port, '/assets/app.js');
  assert.equal(app.status, 200);
  assert.equal(app.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await call(port, '/assets/styles.css')).headers['content-type'], 'text/css; charset=utf-8');
  for (const path of ['/assets/index.html', '/assets/nope.js', '/assets/%2e%2e%2fpackage.json', '/assets/..%2Fserver.mjs']) {
    assert.equal((await call(port, path)).status, 404, path);
  }
});

test('answers only its loopback names, and nothing a proxy forwarded', async (t) => {
  const { port, seen } = await setup(t);
  assert.equal((await call(port, '/', { headers: { host: 'evil.example' } })).status, 421);
  assert.equal((await call(port, '/board/me', { headers: { host: `attacker.test:${port}` } })).status, 421);
  assert.equal((await call(port, '/', { headers: { 'x-forwarded-for': '10.0.0.1' } })).status, 421);
  assert.equal(seen.length, 0);
});

test('proxies the API as the Inspector expects, and refuses writes from other origins', async (t) => {
  const { port, inspectorPort, seen } = await setup(t);
  const body = JSON.stringify({ channel: 'general', text: 'hi' });
  const post = await call(port, '/board/messages?x=1', {
    method: 'POST',
    headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'x-inspect-token': 'fixture-token', 'content-type': 'application/json' },
    body,
  });
  assert.equal(post.status, 201);
  const forwarded = seen.at(-1);
  assert.equal(forwarded.url, '/board/messages?x=1');
  assert.equal(forwarded.headers.host, `127.0.0.1:${inspectorPort}`);
  assert.equal(forwarded.headers.origin, `http://127.0.0.1:${inspectorPort}`);
  assert.equal(forwarded.headers['x-inspect-token'], 'fixture-token');
  assert.equal(forwarded.body, body);

  const count = seen.length;
  for (const origin of [undefined, 'https://evil.example', `http://127.0.0.1:${port + 1}`]) {
    const headers = { 'x-inspect-token': 'fixture-token', ...(origin ? { origin } : {}) };
    assert.equal((await call(port, '/board/messages', { method: 'POST', headers, body })).status, 403, String(origin));
  }
  assert.equal(seen.length, count);
});

test('serves the Inspector itself under /classic', async (t) => {
  const { port, seen } = await setup(t);
  const page = await call(port, '/classic');
  assert.equal(page.status, 200);
  assert.match(page.text, /<meta name="inspect-base" content="\/classic">/);
  assert.match(page.text, /<script type="module" src="\/classic\/app\.js\?v=0\.54\.0">/);
  assert.equal(page.headers['content-security-policy'], "default-src 'none'");
  assert.equal(page.headers.etag, undefined);
  assert.equal(Number(page.headers['content-length']), Buffer.byteLength(page.text));
  assert.equal(seen.at(-1).url, '/');

  assert.equal((await call(port, '/classic/app.js?v=0.54.0')).text, '/* classic */');
  const api = await call(port, '/classic/board/threads?channel=general', { headers: { 'x-inspect-token': 'fixture-token' } });
  assert.equal(JSON.parse(api.text).url, '/board/threads?channel=general');
  assert.equal((await call(port, '/classic?tab=1')).status, 200);
  assert.equal(seen.at(-1).url, '/?tab=1');
});

test('answers https and http on the same port, each from its own origin', async (t) => {
  const tls = certificate(t);
  if (!tls) return t.skip('openssl is not available');
  const { port, inspectorPort, seen } = await setup(t, tls);
  const ca = tls.cert;

  assert.equal((await call(port, '/')).status, 200);
  const page = await call(port, '/c/general', { ca });
  assert.equal(page.status, 200);
  assert.match(page.text, /<meta name="board-token" content="fixture-token">/);
  assert.equal((await call(port, '/classic', { ca })).status, 200);

  const body = JSON.stringify({ text: 'hi' });
  const headers = { 'x-inspect-token': 'fixture-token', 'content-type': 'application/json' };
  const post = await call(port, '/board/messages', { ca, method: 'POST', headers: { ...headers, origin: `https://localhost:${port}` }, body });
  assert.equal(post.status, 201);
  assert.equal(seen.at(-1).headers.origin, `http://127.0.0.1:${inspectorPort}`);

  const count = seen.length;
  assert.equal((await call(port, '/board/messages', { ca, method: 'POST', headers: { ...headers, origin: `http://localhost:${port}` }, body })).status, 403);
  assert.equal((await call(port, '/board/messages', { method: 'POST', headers: { ...headers, origin: `https://127.0.0.1:${port}` }, body })).status, 403);
  assert.equal((await call(port, '/', { ca, headers: { host: 'evil.example' } })).status, 421);
  assert.equal(seen.length, count);
});
