// Zero-dependency static server. Web Bluetooth only works on secure origins,
// and http://localhost counts as one, so this is all the app needs.
//   node scripts/serve.js [port]

import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv[2] || process.env.PORT || 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// The one thing the app may write: the bike's calibration, kept in the repo.
const CALIBRATION_FILE = join(root, 'calibration.json');
const MAX_BODY = 1024 * 1024;

async function saveCalibration(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) {
      res.writeHead(413).end('Too large');
      return;
    }
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = null;
  }
  if (!data?.model?.calibrated) {
    res.writeHead(400).end('Not a calibration');
    return;
  }
  await writeFile(CALIBRATION_FILE, `${JSON.stringify(data, null, 1)}\n`);
  console.log(`Saved calibration to ${CALIBRATION_FILE}`);
  res.writeHead(204).end();
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'PUT' && url.pathname === '/calibration.json') {
      await saveCalibration(req, res);
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (path === '' || path.endsWith('/')) path = join(path, 'index.html');
    const file = resolve(root, path);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Pacer running at http://localhost:${port}`);
  console.log('Open it in Chrome or Edge to use Web Bluetooth.');
});
