import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBoardWeb } from './lib/server.mjs';

const port = readPort('PORT', 4747);
const inspectorPort = readPort('INSPECTOR_PORT', 4748);
if (port === inspectorPort) throw new Error('PORT and INSPECTOR_PORT must differ.');
const tls = readTls();

const server = createBoardWeb({ inspectorPort, tls });
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Stop the existing listener or set PORT for a temporary preview.`
    : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  const urls = [`http://127.0.0.1:${port}`, ...(tls ? [`https://localhost:${port}`] : [])];
  console.log(`Board Web: ${urls.join('  ')}  (classic Inspector: /classic, API: 127.0.0.1:${inspectorPort})`);
});

function readPort(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535.`);
  }
  return port;
}

/** The certificate `scripts/setup-https.sh` makes, or the one TLS_CERT and TLS_KEY name. */
function readTls() {
  const dir = join(homedir(), '.config', 'board-web', 'tls');
  const cert = process.env.TLS_CERT ?? join(dir, 'localhost.crt');
  const key = process.env.TLS_KEY ?? join(dir, 'localhost.key');
  if (!process.env.TLS_CERT && !process.env.TLS_KEY && !(existsSync(cert) && existsSync(key))) return null;
  return { cert: readFileSync(cert), key: readFileSync(key) };
}
