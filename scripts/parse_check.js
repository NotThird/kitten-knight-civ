// scripts/parse_check.js
// Validates ALL JS files in the game can be parsed as ES modules.
// This is the safety gate that prevents broken code from reaching production.
// Run: node scripts/parse_check.js
//
// CRITICAL: Every .js file under js/ MUST pass this check.
// If this script fails, the code MUST NOT be pushed to GitHub.

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

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const file of files) {
    const basename = path.basename(file);
    try {
      // Use Node's --check flag with ES module input type for strict validation
      execSync(`node --check --input-type=module`, {
        input: fs.readFileSync(file, 'utf8'),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      passed++;
    } catch (err) {
      // pwa.js and similar non-module scripts — try as regular script
      try {
        execSync(`node --check`, {
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

  // Also check index.html for malformed script tags
  const indexPath = path.resolve(__dirname, '../index.html');
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8');
    const scriptTagCount = (html.match(/<script/g) || []).length;
    const closeTagCount = (html.match(/<\/script>/g) || []).length;
    if (scriptTagCount !== closeTagCount) {
      failed++;
      failures.push({ file: 'index.html', error: `Mismatched script tags: ${scriptTagCount} open, ${closeTagCount} close` });
      console.error(`FAIL: index.html — mismatched script tags`);
    }
  }

  console.log(`\nChecked ${files.length} JS files: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\nPARSE_IMPORT_FAIL');
    console.error('Failures:');
    for (const f of failures) {
      console.error(`  ${f.file}: ${f.error}`);
    }
    process.exit(1);
  }

  console.log('PARSE_IMPORT_OK');
}

main();
