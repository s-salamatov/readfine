// Fixture server for the e2e suite: serves tests/e2e/.work/fixtures (the images the
// seed writes) on 127.0.0.1:4252. Started and stopped by Playwright (webServer).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_PORT, APP_ENV } from '../env.mjs';

const dir = APP_ENV.E2E_FIXTURE_DIR;
const types = { '.png': 'image/png', '.xml': 'application/rss+xml', '.html': 'text/html' };

http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/health') { res.writeHead(200); res.end('ok'); return; }
  const file = path.join(dir, path.normalize(rel));
  if (!file.startsWith(dir + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(FIXTURE_PORT, '127.0.0.1');
