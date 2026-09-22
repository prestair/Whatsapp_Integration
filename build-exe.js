// Build script: bundle the ESM-heavy app into a single CommonJS file with
// esbuild, copy the public/ assets next to it, then package a standalone
// Windows EXE with @yao-pkg/pkg.
//
// Why bundle first? Baileys v7+ is ESM-only and pkg cannot handle ESM /
// dynamic import() inside its snapshot. esbuild converts everything to a
// single CJS file, which pkg packages cleanly.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BUILD_DIR = path.join(ROOT, 'build');
const BUNDLE = path.join(BUILD_DIR, 'bundle.js');
const OUT_EXE = path.join(ROOT, 'dist', 'WhatsAppDashboard.exe');

function run(cmd) {
  console.log('> ' + cmd);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 1. Clean + bundle
fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });
run('npx esbuild server.js --bundle --platform=node --target=node20 --outfile="' + BUNDLE + '" --format=cjs');

// 1b. Patch dynamic import() of node core modules in the bundle.
// Baileys' media upload uses `await import('https')` / `await import('http')`,
// which throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING inside a pkg EXE and
// causes "Media upload failed on all hosts". Replace those dynamic imports
// with a static require so the packaged EXE can upload media.
(() => {
  let code = fs.readFileSync(BUNDLE, 'utf8');
  const before = code;
  // Handle esbuild's various shapes for dynamic import of core modules.
  code = code
    .replace(/import\(\s*["']https["']\s*\)/g, 'Promise.resolve(require("https"))')
    .replace(/import\(\s*["']http["']\s*\)/g, 'Promise.resolve(require("http"))')
    .replace(/__toESM\(import\(\s*["']https["']\s*\)\)/g, '__toESM(require("https"))')
    .replace(/__toESM\(import\(\s*["']http["']\s*\)\)/g, '__toESM(require("http"))');
  if (code !== before) {
    fs.writeFileSync(BUNDLE, code);
    console.log('Patched dynamic import() of http/https for pkg compatibility.');
  } else {
    console.log('No dynamic http/https import() found to patch (already static?).');
  }
})();

// 2. Copy public assets so __dirname/public resolves inside the snapshot
copyDir(path.join(ROOT, 'public'), path.join(BUILD_DIR, 'public'));
console.log('Copied public/ -> build/public/');

// 3. Package the EXE from the bundle
run('npx pkg "' + BUNDLE + '" --config package.json --targets node20.18.0-win-x64 --output "' + OUT_EXE + '"');

console.log('\nDone. EXE at: ' + OUT_EXE);
