// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Local preview server for the extension UI (popup/sidepanel/documents).
 * Serves the built `dist/` directory on http://localhost:8333 so the pages
 * can be viewed in a normal browser tab for visual QA. The chrome.* APIs are
 * not available outside the extension runtime, so interactive scanning still
 * requires loading the unpacked extension (see README).
 *
 *   npm run preview
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT) || 8333;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.md': 'text/plain'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/landing.html';
  const file = normalize(join(root, pathname));
  if (!file.startsWith(normalize(root))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`not found: ${pathname}`);
  }
});

server.listen(port, () => {
  console.log(`GovernWorld extension preview: http://localhost:${port}`);
  console.log(`  landing     : http://localhost:${port}/landing.html`);
  console.log(`  side panel  : http://localhost:${port}/sidepanel.html`);
  console.log(`  popup       : http://localhost:${port}/popup.html`);
});
