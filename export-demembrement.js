#!/usr/bin/env node
/**
 * export-demembrement.js
 *
 * Récupère les 451 leads du programme 417 (Démembrement de propriété) et
 * leur "Demande d'information" (message initial du prospect) via l'API Adlead.
 *
 * Sortie : demembrement-export.json (à côté de ce script)
 *
 * Usage :
 *   ADLEAD_API_KEY=xxx node export-demembrement.js
 *
 * Ou si tu as un .env à la racine du projet, il sera lu automatiquement.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Lecture .env (best-effort, sans dépendance) ─────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const API_KEY    = process.env.ADLEAD_API_KEY;
const TENANT     = process.env.ADLEAD_TENANT   || 'catella';
const API_BASE   = process.env.ADLEAD_API_BASE || 'https://app.adlead.immo/api/v1';
const PROGRAM_ID = process.env.PROGRAM_ID      || '417';
const PER_PAGE   = 100;
const CONCURRENCY = 6;          // nb d'appels // pour les détails leads
const DETAIL_THROTTLE_MS = 80;  // petite pause anti-rate-limit

if (!API_KEY) {
  console.error('❌ ADLEAD_API_KEY manquante. Lance avec : ADLEAD_API_KEY=xxx node export-demembrement.js');
  process.exit(1);
}

const HEADERS = {
  'X-API-Key': API_KEY,
  'Accept': 'application/json',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function adleadGet(pathStr) {
  const url = `${API_BASE}/${TENANT}${pathStr}`;
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} on ${pathStr}: ${String(text).slice(0, 200)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ── Étape 1 : trouver l'endpoint qui liste les leads d'un programme ─────────
// On essaie plusieurs patterns pour rester robuste à la doc Adlead.
async function discoverListEndpoint() {
  const candidates = [
    `/programs/${PROGRAM_ID}/leads?page=1&per_page=${PER_PAGE}`,
    `/programs/${PROGRAM_ID}/leads?limit=${PER_PAGE}&offset=0`,
    `/programs/${PROGRAM_ID}/contact-management/leads?page=1&per_page=${PER_PAGE}`,
    `/programs/${PROGRAM_ID}/contacts?page=1&per_page=${PER_PAGE}`,
    `/programs/${PROGRAM_ID}/interests?page=1&per_page=${PER_PAGE}&include=lead`,
    `/programs/${PROGRAM_ID}/interests?page=1&per_page=${PER_PAGE}`,
    `/programs/${PROGRAM_ID}/contacts-leads?page=1&per_page=${PER_PAGE}`,
    `/leads?program_id=${PROGRAM_ID}&page=1&per_page=${PER_PAGE}`,
    `/leads?programId=${PROGRAM_ID}&page=1&per_page=${PER_PAGE}`,
    `/leads?filter[program_id]=${PROGRAM_ID}&page=1&per_page=${PER_PAGE}`,
    `/contacts?program_id=${PROGRAM_ID}&page=1&per_page=${PER_PAGE}`,
    `/programs/${PROGRAM_ID}`,                       // dump du programme : peut contenir une clé "leads"
    `/programs/${PROGRAM_ID}/registrations?page=1&per_page=${PER_PAGE}`,
  ];
  console.log('   API_BASE :', API_BASE);
  console.log('   TENANT   :', TENANT);
  console.log('   programme:', PROGRAM_ID);
  console.log('   --');
  for (const c of candidates) {
    const display = c.split('?')[0];
    try {
      const r = await adleadGet(c);
      const data = r?.data || r;
      if (Array.isArray(data)) {
        if (data.length > 0) {
          console.log(`✅ ${display} → 200 OK, ${data.length} items page 1`);
          // On peut s'arrêter là si la première entrée ressemble à un lead/contact
          const sample = data[0];
          const sampleKeys = Object.keys(sample || {}).slice(0, 12).join(', ');
          console.log(`   exemple keys : ${sampleKeys}`);
          return display;
        } else {
          console.log(`⚠️  ${display} → 200 mais 0 items`);
        }
      } else if (data && typeof data === 'object') {
        // Cas /programs/{id} : on regarde s'il y a un sous-tableau "leads", "contacts", etc.
        const interesting = Object.entries(data)
          .filter(([k,v]) => Array.isArray(v) && v.length > 0)
          .map(([k,v]) => `${k}[${v.length}]`)
          .join(', ');
        console.log(`ℹ️  ${display} → 200 objet, sous-tableaux : ${interesting || '(aucun)'}`);
      } else {
        console.log(`?  ${display} → 200 mais format inattendu`);
      }
    } catch (e) {
      const bodyHint = e.body ? (typeof e.body === 'string' ? e.body : JSON.stringify(e.body)).slice(0, 150) : '';
      console.log(`❌ ${display} → ${e.status || 'erreur'} ${bodyHint}`);
    }
  }
  throw new Error('Aucun endpoint de liste de leads ne fonctionne. Voir messages ci-dessus pour diagnostiquer.');
}

// ── Étape 2 : paginer la liste complète ─────────────────────────────────────
async function listAll(endpointPath) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const sep = endpointPath.includes('?') ? '&' : '?';
    const url = `${endpointPath}${sep}page=${page}&per_page=${PER_PAGE}`;
    let r;
    try { r = await adleadGet(url); }
    catch (e) {
      console.error(`Erreur page ${page} : ${e.message}`);
      break;
    }
    const data = r?.data || r;
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    console.log(`   page ${page} → ${data.length} leads (total ${all.length})`);
    if (data.length < PER_PAGE) break;
  }
  return all;
}

// ── Étape 3 : extraire le message initial d'un lead ─────────────────────────
// Stratégie : récupérer events ou records, chercher le 1er événement de type
// "Demande d'information" / "information_request" / "interest_created" et
// extraire le champ "message" / "comment" / "content".
async function fetchInitialMessage(leadId) {
  const tries = [
    `/programs/${PROGRAM_ID}/leads/${leadId}/events`,
    `/programs/${PROGRAM_ID}/leads/${leadId}/records`,
    `/leads/${leadId}/events`,
  ];
  for (const t of tries) {
    try {
      const r = await adleadGet(t);
      const arr = r?.data || r;
      if (!Array.isArray(arr)) continue;

      // On cherche le bon événement
      const wanted = arr.find(ev => {
        const type = (ev.type || ev.event_type || ev.kind || '').toString().toLowerCase();
        const title = (ev.title || ev.name || ev.label || '').toString().toLowerCase();
        return type.includes('information') || type.includes('demande') ||
               type.includes('interest') || title.includes('demande d\'information') ||
               title.includes('demande d’information');
      }) || arr[arr.length - 1] || arr[0];

      if (!wanted) continue;
      const msg = wanted.message || wanted.client_message || wanted.content ||
                  wanted.comment || wanted.body || wanted.description ||
                  (wanted.payload && (wanted.payload.message || wanted.payload.comment)) ||
                  '';
      const date = wanted.created_at || wanted.date || wanted.occurred_at || '';
      return { message: String(msg).trim(), date, source_endpoint: t, raw: wanted };
    } catch (e) {
      // continue silencieusement, on essaie l'endpoint suivant
    }
  }
  // Fallback : dump complet du lead, scan des champs
  try {
    const r = await adleadGet(`/programs/${PROGRAM_ID}/leads/${leadId}?include=events,records,interests`);
    const lead = r?.data || r;
    const candidates = [];
    const visit = (obj, p='') => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k,v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.length > 20 &&
            /demande|message|cordialement|bonjour|intéressé|information/i.test(v)) {
          candidates.push({ path: `${p}.${k}`, value: v });
        }
        if (typeof v === 'object') visit(v, `${p}.${k}`);
      }
    };
    visit(lead);
    if (candidates.length) {
      candidates.sort((a,b) => b.value.length - a.value.length);
      return { message: candidates[0].value.trim(), date: lead.created_at || '', source_endpoint: 'lead-scan', raw: { hint: candidates[0].path } };
    }
  } catch {}
  return { message: '', date: '', source_endpoint: null, raw: null };
}

// ── Pool de promesses (concurrence simple) ──────────────────────────────────
async function pool(items, fn, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { __error: e.message }; }
      done++;
      if (done % 25 === 0 || done === items.length) {
        process.stdout.write(`\r   détails ${done}/${items.length}... `);
      }
      if (DETAIL_THROTTLE_MS) await sleep(DETAIL_THROTTLE_MS);
    }
  }));
  process.stdout.write('\n');
  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Adlead export — programme ${PROGRAM_ID} (tenant: ${TENANT})`);
  console.log('-----------------------------------------------------------');

  console.log('🔍 Détection de l\'endpoint de liste...');
  const listPath = await discoverListEndpoint();

  console.log('📋 Pagination complète des leads...');
  const leads = await listAll(listPath);
  console.log(`   → ${leads.length} leads récupérés`);

  // Normalisation : on suppose que chaque item a un id ou contient un lead.id
  const normalized = leads.map(item => {
    const lead = item.lead || item;
    return {
      id:        lead.id || lead.lead_id || item.id,
      first_name: lead.first_name || lead.firstname || lead.contact?.first_name || '',
      last_name:  lead.last_name  || lead.lastname  || lead.contact?.last_name  || '',
      civility:   lead.civility   || lead.contact?.civility || '',
      email:      lead.email      || lead.contact?.email || '',
      phone:      lead.phone      || lead.mobile    || lead.contact?.phone || '',
      status:     lead.status     || item.status    || '',
      created_at: lead.created_at || item.created_at || '',
      updated_at: lead.updated_at || item.updated_at || '',
      origin:     lead.origin     || lead.source    || item.origin || '',
      raw:        item,
    };
  });

  console.log('💬 Récupération des messages initiaux (peut prendre 1–3 min)...');
  const enriched = await pool(normalized, async (lead) => {
    if (!lead.id) return { ...lead, message_initial: '', message_date: '', message_source: null };
    const m = await fetchInitialMessage(lead.id);
    return {
      ...lead,
      message_initial: m.message,
      message_date:    m.date,
      message_source:  m.source_endpoint,
    };
  });

  const outPath = path.join(__dirname, 'demembrement-export.json');
  // On ne garde pas le payload brut dans le JSON final (trop volumineux),
  // mais on l'écrit séparément si besoin de debug.
  const slim = enriched.map(({ raw, ...rest }) => rest);
  fs.writeFileSync(outPath, JSON.stringify(slim, null, 2), 'utf8');

  const withMsg = slim.filter(l => l.message_initial && l.message_initial.length > 5).length;
  console.log('-----------------------------------------------------------');
  console.log(`✅ Export terminé : ${slim.length} leads, ${withMsg} avec message initial`);
  console.log(`   Fichier : ${outPath}`);
})().catch(err => {
  console.error('💥', err.message);
  if (err.body) console.error('   Body API :', JSON.stringify(err.body).slice(0, 500));
  process.exit(1);
});
