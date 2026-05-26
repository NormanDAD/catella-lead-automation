#!/usr/bin/env node
/**
 * upload-brochures.js
 * Uploade les PDFs vers Railway en se basant sur le mapping brochures.json.
 * Usage : UPLOAD_TOKEN=xxx node scripts/upload-brochures.js [--only slug1,slug2]
 */

const fs   = require('fs');
const path = require('path');

const TOKEN       = process.env.UPLOAD_TOKEN || '';
const BASE_URL    = process.env.RAILWAY_URL  || 'https://lead-automation-production-33e8.up.railway.app';
const SRC_DIR     = path.join(process.env.HOME, 'Documents', 'Brochures');
const BROCHURES   = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'brochures.json'), 'utf8'));

const onlyIdx  = process.argv.indexOf('--only');
const ONLY_SET = onlyIdx >= 0 ? new Set(process.argv[onlyIdx + 1].split(',')) : null;

if (!TOKEN) { console.error('❌ UPLOAD_TOKEN manquant'); process.exit(1); }

function toSlug(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['']/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
}

function parseFilename(filename) {
  const base  = filename.replace(/\.pdf$/i, '');
  const parts = base.split(' - ');
  if (parts.length < 3) return null;
  const programme  = parts[1].trim();
  const rest       = parts.slice(3).join(' ');
  const vMatch     = rest.match(/^v(\d+)\b/i);
  const versionNum = vMatch ? parseInt(vMatch[1], 10) : 0;
  return { programme, versionNum, filename };
}

const slugToSrc = {};
for (const f of fs.readdirSync(SRC_DIR).filter(f => f.toLowerCase().endsWith('.pdf'))) {
  const parsed = parseFilename(f);
  if (!parsed) continue;
  const slug = toSlug(parsed.programme) + '.pdf';
  const existing = slugToSrc[slug];
  if (!existing || parsed.versionNum === 0 ||
      (existing.versionNum !== 0 && parsed.versionNum < existing.versionNum)) {
    slugToSrc[slug] = { src: f, versionNum: parsed.versionNum };
  }
}

async function uploadFile(slug, srcFile) {
  const srcPath = path.join(SRC_DIR, srcFile);
  const stat    = fs.statSync(srcPath);
  const encoded = encodeURIComponent(slug);
  const url     = `${BASE_URL}/api/admin/upload-brochure?filename=${encoded}`;

  // Pour les gros fichiers (>20Mo) : streamer par chunks via Node HTTP
  // plutôt que charger tout en mémoire.
  const https   = require('https');
  const http    = require('http');
  const urlObj  = new URL(url);
  const lib     = urlObj.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = lib.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  {
        'x-admin-token':  TOKEN,
        'Content-Type':   'application/octet-stream',
        'Content-Length': stat.size,
      },
      timeout: 120000,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        const json = JSON.parse(body || '{}');
        resolve({ ok: res.statusCode === 200, status: res.statusCode, bytes: json.bytes || stat.size });
      });
    });
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    fs.createReadStream(srcPath).pipe(req);
  });
}

(async () => {
  const slugs   = [...new Set(Object.values(BROCHURES))].filter(s => !ONLY_SET || ONLY_SET.has(s));
  let ok = 0, fail = 0, missing = 0;

  for (const slug of slugs) {
    const entry = slugToSrc[slug];
    if (!entry) { console.log(`·  ${slug}  — source introuvable`); missing++; continue; }
    const sizeMb = (fs.statSync(path.join(SRC_DIR, entry.src)).size / 1024 / 1024).toFixed(1);
    process.stdout.write(`⬆  ${slug} (${sizeMb} Mo) ... `);
    const r = await uploadFile(slug, entry.src);
    if (r.ok) { console.log(`✅`); ok++; }
    else      { console.log(`❌ (${r.error || 'HTTP ' + r.status})`); fail++; }
  }

  console.log(`\nTerminé : ${ok} ok · ${fail} erreurs · ${missing} sources manquantes`);
})();
