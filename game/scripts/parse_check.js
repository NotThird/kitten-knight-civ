// scripts/parse_check.js
// Minimal parse/import sanity check for the browser-targeted ES modules.
// Run: node scripts/parse_check.js

const path = require('path');
const { pathToFileURL } = require('url');

async function main(){
  const roots = [
    '../js/sim.js',
    '../js/state.js',
    '../js/util.js',
    '../js/tasks_core.js',
    '../js/tasks_lite.js',
  ];

  for (const rel of roots) {
    const url = pathToFileURL(path.resolve(__dirname, rel)).href;
    await import(url);
  }

  console.log('PARSE_IMPORT_OK');
}

main().catch((err) => {
  console.error('PARSE_IMPORT_FAIL');
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
