#!/usr/bin/env node
/**
 * build-brochures.js
 *
 * 1. Lit ~/Documents/Brochures/
 * 2. Extrait le nom de programme (2e segment du nom de fichier)
 * 3. Croise avec programmes.json (matching insensible à la casse)
 * 4. Pour les multi-versions, garde v1 (ou la version sans numéro)
 * 5. Copie les PDFs dans public/brochures/ avec un nom URL-safe
 * 6. Génère brochures.json : { "Nom Programme": "url-safe-name.pdf" }
 *
 * Usage : node scripts/build-brochures.js [--dry-run]
 */

const fs   = require('fs');
const path = require('path');

const DRY_RUN       = process.argv.includes('--dry-run');
const SRC_DIR       = path.join(process.env.HOME, 'Documents', 'Brochures');
// Destination locale : data/brochures/ (= ce que Railway volume expose)
const DEST_DIR      = path.join(__dirname, '..', 'data', 'brochures');
const PROGRAMMES_JS = path.join(__dirname, '..', 'programmes.json');
const OUTPUT_JSON   = path.join(__dirname, '..', 'brochures.json');

// ─── helpers ────────────────────────────────────────────────────────────────

function toSlug(str) {
  return str
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // diacritics
    .replace(/['']/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
}

function normalizeForMatch(str) {
  return str
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── parse filename ──────────────────────────────────────────────────────────
// Format : "VILLE - PROGRAMME - PROMOTEUR - [vN description].pdf"
// Returns { programme, versionNum } or null

function parseFilename(filename) {
  const base = filename.replace(/\.pdf$/i, '');
  const parts = base.split(' - ');
  if (parts.length < 3) return null;
  const programmePart = parts[1].trim();

  // Extract version number if present in part[3]+
  const rest = parts.slice(3).join(' ');
  const vMatch = rest.match(/^v(\d+)\b/i);
  const versionNum = vMatch ? parseInt(vMatch[1], 10) : 0;

  return { programme: programmePart, versionNum, filename };
}

// ─── load programmes.json ────────────────────────────────────────────────────

const programmes = JSON.parse(fs.readFileSync(PROGRAMMES_JS, 'utf8'));
const progKeys   = Object.keys(programmes);
const progNorm   = progKeys.map(k => ({ key: k, norm: normalizeForMatch(k) }));

function findProgrammeKey(name) {
  const n = normalizeForMatch(name);
  // Exact
  let hit = progNorm.find(p => p.norm === n);
  if (hit) return hit.key;
  // Programme name starts with / contains
  hit = progNorm.find(p => p.norm === n || n.startsWith(p.norm) || p.norm.startsWith(n));
  if (hit) return hit.key;
  return null;
}

// ─── group by programme, keep best version ──────────────────────────────────

const files = fs.readdirSync(SRC_DIR)
  .filter(f => f.toLowerCase().endsWith('.pdf'));

const grouped = {}; // programme (raw) → best { filename, versionNum }

for (const f of files) {
  const parsed = parseFilename(f);
  if (!parsed) { console.warn(`⚠️  skip (parse fail): ${f}`); continue; }

  const { programme, versionNum, filename } = parsed;
  const key = programme.toUpperCase();

  if (!grouped[key]) {
    grouped[key] = { programme, versionNum, filename };
  } else {
    // Prefer v0 (no version) or lowest version number
    const cur = grouped[key];
    if (versionNum === 0 || (cur.versionNum !== 0 && versionNum < cur.versionNum)) {
      grouped[key] = { programme, versionNum, filename };
    }
  }
}

// ─── build mapping ───────────────────────────────────────────────────────────

const brochures   = {}; // nom_programme → slug.pdf
const unmatched   = [];
const matched     = [];

if (!DRY_RUN) {
  fs.mkdirSync(DEST_DIR, { recursive: true });
}

for (const [, { programme, filename }] of Object.entries(grouped)) {
  const progKey = findProgrammeKey(programme) || programme;
  const slug    = toSlug(programme) + '.pdf';
  const srcPath = path.join(SRC_DIR, filename);
  const dstPath = path.join(DEST_DIR, slug);

  brochures[progKey] = slug;

  if (findProgrammeKey(programme)) {
    matched.push({ progKey, slug, src: filename });
  } else {
    unmatched.push({ programme, slug, src: filename });
  }

  if (!DRY_RUN) {
    fs.copyFileSync(srcPath, dstPath);
  }
}

// ─── write brochures.json ────────────────────────────────────────────────────

if (!DRY_RUN) {
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(brochures, null, 2));
  console.log(`\n✅ brochures.json écrit (${Object.keys(brochures).length} entrées)`);
  console.log(`✅ PDFs copiés dans ${DEST_DIR}`);
} else {
  console.log('\n[DRY RUN — aucun fichier écrit]\n');
}

console.log(`\n📎 Matchés avec programmes.json (${matched.length}) :`);
for (const m of matched) {
  console.log(`  ✅ "${m.progKey}"  →  ${m.slug}`);
}

console.log(`\n❓ Pas dans programmes.json (${unmatched.length}) — utilisés tels quels :`);
for (const u of unmatched) {
  console.log(`  ·  "${u.programme}"  →  ${u.slug}`);
}
