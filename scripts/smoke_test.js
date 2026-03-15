#!/usr/bin/env node
/**
 * smoke_test.js — Browser-based smoke test for Kitten Knight Civ.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  DO NOT MODIFY THIS FILE. This is a safety gate.                    ██
 * ██  It launches the game in a real browser and checks for errors.      ██
 * ██  If this test fails, the game is BROKEN and must NOT be published.  ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * Requires: puppeteer (installed globally or via npx)
 * Run: node game/scripts/smoke_test.js
 * Exit 0 = PASS, Exit 1 = FAIL
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const GAME_DIR = path.resolve(__dirname, '..');
const PORT = 9876; // Unlikely to conflict
const TIMEOUT_MS = 15000;

// Simple static file server
function startServer() {
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  const server = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(GAME_DIR, urlPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const mime = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(PORT, () => resolve(server));
  });
}

async function runSmokeTest() {
  let server;
  let browser;
  const errors = [];

  try {
    // Step 1: Start local server
    server = await startServer();
    console.log(`[smoke] Server started on port ${PORT}`);

    // Step 2: Launch headless browser
    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch (e) {
      // Try to find it via npx install location
      const { execSync } = require('child_process');
      const modPath = execSync('node -e "console.log(require.resolve(\'puppeteer\'))"', {
        encoding: 'utf8',
        timeout: 30000,
      }).trim();
      puppeteer = require(path.dirname(path.dirname(modPath)));
    }

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      timeout: 10000,
    });

    const page = await browser.newPage();

    // Step 3: Collect JS errors
    page.on('pageerror', (err) => {
      errors.push(`JS Error: ${err.message}`);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(`Console Error: ${msg.text()}`);
      }
    });

    // Step 4: Load the game
    console.log('[smoke] Loading game...');
    await page.goto(`http://localhost:${PORT}/`, {
      waitUntil: 'networkidle2',
      timeout: TIMEOUT_MS,
    });

    // Step 5: Wait for game to initialize (give it 3 seconds)
    await new Promise(r => setTimeout(r, 3000));

    // Step 6: Check critical DOM elements exist
    const checks = [
      { selector: 'body', name: 'body element' },
      { selector: '#directorSection', name: 'director section' },
    ];

    for (const check of checks) {
      const el = await page.$(check.selector);
      if (!el) {
        errors.push(`Missing DOM: ${check.name} (${check.selector})`);
      }
    }

    // Step 7: Check page title loaded (not blank/error page)
    const title = await page.title();
    if (!title || title.toLowerCase().includes('error')) {
      errors.push(`Bad page title: "${title}"`);
    }

    // Step 8: Check that the page has substantial content (not a blank error)
    const bodyText = await page.evaluate(() => document.body?.innerText?.length || 0);
    if (bodyText < 100) {
      errors.push(`Page body too short (${bodyText} chars) — likely broken`);
    }

  } catch (err) {
    errors.push(`Smoke test crash: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  }

  // Report
  if (errors.length === 0) {
    console.log('\n[smoke] SMOKE_TEST_OK — Game loads without errors');
    return true;
  } else {
    console.error('\n[smoke] SMOKE_TEST_FAIL — Game is broken:');
    for (const e of errors) console.error(`  ✗ ${e}`);
    return false;
  }
}

runSmokeTest().then(ok => {
  process.exit(ok ? 0 : 1);
});
