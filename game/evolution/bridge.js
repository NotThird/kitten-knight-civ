#!/usr/bin/env node
// bridge.js — tiny HTTP bridge for automated evolution triggers
//
// Runs a localhost server that receives POST requests from the game
// and writes trigger files to evolution/triggers/.
//
// Usage:
//   node evolution/bridge.js [port]
//   Default port: 7331
//
// The game can POST to http://localhost:7331/trigger with a JSON body.
// The bridge writes it to evolution/triggers/{timestamp}.json.

import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRIGGERS_DIR = join(__dirname, 'triggers');
const PORT = Number(process.argv[2]) || 7331;

// Ensure triggers directory exists
mkdirSync(TRIGGERS_DIR, { recursive: true });

const server = createServer((req, res) => {
  // CORS headers for browser requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/trigger') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const filename = `${Date.now()}.json`;
        const filepath = join(TRIGGERS_DIR, filename);
        writeFileSync(filepath, JSON.stringify(data, null, 2));
        console.log(`[bridge] Wrote trigger: ${filename}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file: filename }));
      } catch (err) {
        console.error(`[bridge] Error:`, err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, triggers_dir: TRIGGERS_DIR }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[bridge] Evolution bridge listening on http://localhost:${PORT}`);
  console.log(`[bridge] POST /trigger to write evolution triggers`);
  console.log(`[bridge] Triggers dir: ${TRIGGERS_DIR}`);
});
