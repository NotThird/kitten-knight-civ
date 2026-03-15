// parse_check.js — Validates ALL JS files in game/js/ as ES modules.
//
// ██████████████████████████████████████████████████████████████████████████
// ██  DO NOT MODIFY THIS FILE. DO NOT REVERT TO AN OLD VERSION.          ██
// ██  This file was manually written by Austin to check ALL .js files.   ██
// ██  Any agent that reverts this to only check 5 files is BREAKING      ██
// ██  THE SAFETY GATE and will allow broken code to reach production.    ██
// ██  The game was broken in production TWICE because agents reverted    ██
// ██  this file. DO NOT TOUCH IT.                                       ██
// ██████████████████████████████████████████████████████████████████████████
//
// Run: node game/scripts/parse_check.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const JS_DIR = path.resolve(__dirname, '../js');

function main() {
  const files = fs.readdirSync(JS_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(JS_DIR, f));

  if (files.length === 0) {
    console.error('PARSE_FAIL: No .js files found in', JS_DIR);
    process.exit(1);
  }

  // SAFETY: We must check at LEAST 10 files. If fewer are found, something is wrong.
  if (files.length < 10) {
    console.error(`PARSE_FAIL: Expected 10+ JS files, found only ${files.length}. Directory may be wrong.`);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const file of files) {
    const basename = path.basename(file);
    try {
      // Try as ES module first (game uses <script type="module">)
      execSync('node --check --input-type=module', {
        input: fs.readFileSync(file, 'utf8'),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      passed++;
    } catch (err) {
      // Fall back to regular script mode
      try {
        execSync('node --check', {
          input: fs.readFileSync(file, 'utf8'),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });
        passed++;
      } catch (err2) {
        failed++;
        const stderr = (err.stderr || err2.stderr || '').toString().trim();
        const match = stderr.match(/\[stdin\]:(\d+)/);
        const line = match ? ` (line ${match[1]})` : '';
        failures.push({ file: basename, error: stderr.split('\n')[0] + line });
        console.error(`FAIL: ${basename}${line}`);
      }
    }
  }

  // Also check index.html for mismatched script tags
  const indexPath = path.resolve(__dirname, '../index.html');
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8');
    const scriptTagCount = (html.match(/<script/g) || []).length;
    const closeTagCount = (html.match(/<\/script>/g) || []).length;
    if (scriptTagCount !== closeTagCount) {
      failed++;
      failures.push({ file: 'index.html', error: 'Mismatched script tags' });
    }
  }

  console.log(`\nChecked ${files.length} JS files: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\nPARSE_IMPORT_FAIL');
    for (const f of failures) console.error(`  ${f.file}: ${f.error}`);
    process.exit(1);
  }

  console.log('PARSE_IMPORT_OK');
}

main();
