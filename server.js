const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  ADLEAD_WEBHOOK_SECRET: process.env.ADLEAD_WEBHOOK_SECRET || '',
  ADLEAD_API_KEY:        process.env.ADLEAD_API_KEY || '',
  ADLEAD_TENANT:         process.env.ADLEAD_TENANT || 'catella',
  ADLEAD_API_BASE:       process.env.ADLEAD_API_BASE || 'https://app.adlead.immo/api/v1',
  POWER_AUTOMATE_URL:    process.env.POWER_AUTOMATE_URL || '',
  POWER_AUTOMATE_SECRET: process.env.POWER_AUTOMATE_SECRET || '',
  SENDER_EMAIL:          process.env.SENDER_EMAIL || 'norman.dadon@catella.com',
  BOOKING_URL:           process.env.BOOKING_URL || 'https://outlook.office.com/bookwithme/user/923d6c795e8a44b8b1703578fea6c819@catella.com/meetingtype/61-yOXWp3EmR-JEFDg44vA2?anonymous',
  DELAY_HOURS:           Number(process.env.DELAY_HOURS || 24),
  SCHEDULER_INTERVAL_MS: Number(process.env.SCHEDULER_INTERVAL_MS || 5 * 60 * 1000),
  PORT:                  process.env.PORT || 3000,
};

// ─── PROGRAMMES DATA ───────────────────────────────────────────────────────
// Chargé depuis programmes.json au démarrage.
// Keyé par "Nom Adlead" (= interest.program.name renvoyé par l'API).
let PROGRAMMES = {};
function loadProgrammes() {
  try {
    const p = path.join(__dirname, 'programmes.json');
    if (fs.existsSync(p)) {
      PROGRAMMES = JSON.parse(fs.readFileSync(p, 'utf8'));
      console.log(`[programmes] ${Object.keys(PROGRAMMES).length} programmes chargés depuis programmes.json`);
    } else {
      console.warn('[programmes] programmes.json non trouvé — accroches génériques utilisées');
    }
  } catch (e) {
    console.error('[programmes] erreur chargement:', e.message);
  }
}
loadProgrammes();

function findProgramme(name) {
  if (!name) return null;
  // Match exact d'abord
  if (PROGRAMMES[name]) return PROGRAMMES[name];
  // Match insensible à la casse en fallback
  const lower = String(name).toLowerCase().trim();
  for (const key of Object.keys(PROGRAMMES)) {
    if (key.toLowerCase() === lower) return PROGRAMMES[key];
  }
  return null;
}

// ─── PERSISTENCE ────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const PENDING_FILE = path.join(DATA_DIR, 'pending_leads.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed_leads.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[persistence] Erreur lecture ${file}:`, e.message);
    return fallback;
  }
}

function saveJsonFile(file, data) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`[persistence] Erreur écriture ${file}:`, e.message);
  }
}

let pendingLeads = loadJsonFile(PENDING_FILE, []);
let processedLeads = loadJsonFile(PROCESSED_FILE, []);

function savePending() { saveJsonFile(PENDING_FILE, pendingLeads); }
function saveProcessed() { saveJsonFile(PROCESSED_FILE, processedLeads); }

// Backfill: si leadId est manquant sur une entrée existante, essaie de le relire depuis rawPayload.data.context.lead_id
{
  let _backfilled = 0;
  for (const entry of pendingLeads) {
    if (!entry.leadId) {
      const ctxLeadId = entry.rawPayload?.data?.context?.lead_id;
      if (ctxLeadId) {
        entry.leadId = ctxLeadId;
        _backfilled++;
      }
    }
  }
  if (_backfilled > 0) {
    console.log(`[backfill] ${_backfilled} lead(s) récupérés via data.context.lead_id`);
    savePending();
  }
}

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── HELPERS ────────────────────────────────────────────────────────────────

function verifyAdleadSignature(req) {
  if (!CONFIG.ADLEAD_WEBHOOK_SECRET) return true;
  const signature = req.headers['signature'];
  if (!signature) return false;
  const hash = crypto
    .createHmac('sha256', CONFIG.ADLEAD_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');
  return hash === signature;
}

async function adleadGet(path, { allow404 = false } = {}) {
  const url = `${CONFIG.ADLEAD_API_BASE}/${CONFIG.ADLEAD_TENANT}${path}`;
  const res = await fetch(url, {
    headers: {
      'X-API-Key': CONFIG.ADLEAD_API_KEY,
      'Accept': 'application/json',
    },
  });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Adlead API ${res.status} ${res.statusText} on ${path}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data || json;
}

async function adleadPut(path, body) {
  const url = `${CONFIG.ADLEAD_API_BASE}/${CONFIG.ADLEAD_TENANT}${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-API-Key': CONFIG.ADLEAD_API_KEY,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Adlead API PUT ${res.status} ${res.statusText} on ${path}: ${text.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => ({}));
  return json.data || json;
}

async function adleadPost(path, body) {
  const url = `${CONFIG.ADLEAD_API_BASE}/${CONFIG.ADLEAD_TENANT}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-Key': CONFIG.ADLEAD_API_KEY,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Adlead API POST ${res.status} ${res.statusText} on ${path}: ${text.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => ({}));
  return json.data || json;
}

// Update lead interest status (passage à "En attente de contact" = pending)
async function updateLeadStatusPending(programId, leadId) {
  return adleadPut(`/programs/${programId}/leads/${leadId}`, {
    interest: {
      status: 'pending',
      follow_reason: null,
      discard_reason: null,
      deleted_at: null,
    },
  });
}

// Log an "E-mail envoyé" event on the lead (trace un événement passé, pas une action planifiée)
//   Endpoint capturé côté UI : POST /programs/{pid}/leads/{lid}/records
//   body: { occurred_at: "YYYY-MM-DD HH:MM:SS", event: "email", comment: "..." }
async function createRelanceEvent(programId, leadId) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const occurred_at =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const dateFr = now.toLocaleDateString('fr-FR');
  return adleadPost(`/programs/${programId}/leads/${leadId}/records`, {
    occurred_at,
    event: 'email',
    comment: `Relance automatique J+1 envoyée le ${dateFr}`,
  });
}

async function fetchLead(leadId) {
  // Try with includes for interests so we can read status from there
  try {
    return await adleadGet(`/leads/${leadId}?include=interests,interests.program,contacts`);
  } catch (e) {
    return adleadGet(`/leads/${leadId}`);
  }
}

async function fetchProgram(programId) {
  if (!programId) return null;
  try {
    const data = await adleadGet(`/programs/${programId}`, { allow404: true });
    if (data) console.log(`[fetchProgram] OK — program ${programId} → "${data.name || data.nom_commercial || '(sans nom)'}"`);
    else console.log(`[fetchProgram] 404 sur /programs/${programId}`);
    return data;
  } catch (e) {
    console.log(`[fetchProgram] erreur: ${e.message}`);
    return null;
  }
}

async function fetchInterest(interestId, { programId, leadId } = {}) {
  // Try several plausible endpoint shapes — Adlead uses nested resources under programs.
  const candidates = [];
  if (programId) candidates.push(`/programs/${programId}/interests/${interestId}`);
  if (leadId) candidates.push(`/leads/${leadId}/interests/${interestId}`);
  candidates.push(`/interests/${interestId}`);
  let lastError = null;
  for (const path of candidates) {
    try {
      const data = await adleadGet(path, { allow404: true });
      if (data) {
        console.log(`[fetchInterest] OK via ${path}`);
        return data;
      }
      console.log(`[fetchInterest] 404 sur ${path}`);
    } catch (e) {
      lastError = e;
      console.log(`[fetchInterest] erreur sur ${path}: ${e.message}`);
    }
  }
  if (lastError) throw lastError;
  return null;
}

function findInterest(lead, interestId) {
  if (!lead || !Array.isArray(lead.interests)) return null;
  return lead.interests.find(i => String(i.id) === String(interestId)) || null;
}

function splitName(fullname) {
  const trimmed = (fullname || '').trim();
  if (!trimmed) return { firstname: '', lastname: '' };
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { firstname: trimmed, lastname: '' };
  return {
    firstname: trimmed.slice(0, idx).trim(),
    lastname: trimmed.slice(idx + 1).trim(),
  };
}

function buildSalutation(contact) {
  const { firstname, lastname } = splitName(contact.fullname || contact.display_name || '');
  const title = (contact.title || '').trim();
  if (title && lastname) return `${title} ${lastname}`;
  if (lastname) return lastname;
  if (firstname) return firstname;
  return 'Madame, Monsieur';
}

// ─── TEMPLATE EMAIL CATELLA ─────────────────────────────────────────────────

function buildEmailSubject(ctx) {
  return `Votre projet à ${ctx.ville} — quelques précisions sur « ${ctx.programme} »`;
}

function buildEmailBody(ctx) {
  // Accroche programme intégrée dans la phrase d'ouverture (quand elle existe)
  const accrochePhrase = ctx.accroche_programme
    ? ` <em>${escapeHtml(ctx.accroche_programme)}</em> — il pourrait bien répondre à toutes vos attentes !`
    : '';

  return `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222;">
<p>Bonjour ${escapeHtml(ctx.salutation)},</p>

<p>Merci pour l'intérêt que vous portez à notre programme <strong>&laquo;&nbsp;${escapeHtml(ctx.programme)}&nbsp;&raquo;</strong> à ${escapeHtml(ctx.ville)}, proposé par ${escapeHtml(ctx.promoteur)}.${accrochePhrase}</p>

<p>Pour vous proposer les appartements les plus adaptés, j'aurais besoin de quelques précisions sur votre recherche :</p>

<ul style="margin: 8px 0 16px 0; padding-left: 22px;">
  <li>S'agit-il d'une résidence principale ou d'un investissement ?</li>
  <li>Quelle typologie recherchez-vous (T1, T2, T3…) ?</li>
  <li>Avez-vous une préférence d'étage ?</li>
  <li>Une exposition idéale ?</li>
  <li>Quel est votre budget estimé ?</li>
</ul>

<p>Dès réception de vos critères, je pourrai vous envoyer une sélection personnalisée de plans et de prix, idéale pour vous projeter dans votre futur cadre de vie.</p>

<p>👉 Vous pouvez également prendre rendez-vous en ligne avec moi à tout moment : <a href="${ctx.lien_rdv}">Réserver un créneau</a>.<br>
Ou en réponse directement à ce mail.</p>

<p>Au plaisir d'échanger sur votre projet !</p>

<p>Bien à vous,</p>

<p style="margin-top: 24px; font-size: 13px; line-height: 1.5;">
<strong>Norman DADON</strong><br>
Directeur des ventes<br>
<strong>Catella Residential</strong><br>
4 rue de Lasteyrie<br>
75116 Paris<br>
<span style="color:#888;">-----------------------------------------------------------------</span><br>
Tel: +33 (0)1 56 79 79 79<br>
Mobile: +33 (0)6 64 58 24 11<br>
E-mail: <a href="mailto:Norman.Dadon@catella.fr">Norman.Dadon@catella.fr</a><br>
Web: <a href="https://www.catellaresidential.fr">www.catellaresidential.fr</a> | <a href="https://www.catella.com">www.catella.com</a><br>
<span style="color:#888;">-----------------------------------------------------------------</span><br>
<span style="color:#888; font-size: 11px;">P&nbsp;&nbsp; Please consider the environment before printing this e-mail</span>
</p>
</div>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── ENVOI VIA POWER AUTOMATE ───────────────────────────────────────────────

async function sendEmailViaPowerAutomate(to, subject, htmlBody) {
  if (!CONFIG.POWER_AUTOMATE_URL) {
    throw new Error('POWER_AUTOMATE_URL non configuré');
  }
  const payload = {
    to,
    subject,
    html: htmlBody,
    from: CONFIG.SENDER_EMAIL,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.POWER_AUTOMATE_SECRET) {
    headers['x-shared-secret'] = CONFIG.POWER_AUTOMATE_SECRET;
  }
  const res = await fetch(CONFIG.POWER_AUTOMATE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Power Automate ${res.status}: ${err.slice(0, 200)}`);
  }
}

// ─── FLOW PRINCIPAL ─────────────────────────────────────────────────────────

function enqueueLead(payload) {
  const data = payload.data || {};
  const interestId = data.id;
  const leadId = data.lead_id || data.leadId || data.context?.lead_id;
  const programId = data.program_id || data.programId || data.context?.program_id;

  const entry = {
    interestId,
    leadId,
    programId,
    receivedAt: new Date().toISOString(),
    checkAt: new Date(Date.now() + CONFIG.DELAY_HOURS * 60 * 60 * 1000).toISOString(),
    rawPayload: payload,
    attempts: 0,
    maxAttempts: 3,
  };

  pendingLeads.push(entry);
  savePending();
  console.log(`[enqueue] Lead ${leadId} (interest ${interestId}) en attente — check à ${entry.checkAt}`);
  return entry;
}

let schedulerRunning = false;

async function schedulerTick() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const now = Date.now();
    const due = pendingLeads.filter(l => new Date(l.checkAt).getTime() <= now);
    if (due.length === 0) return;
    console.log(`[scheduler] ${due.length} lead(s) à traiter`);
    for (const entry of due) {
      await processPendingLead(entry);
    }
  } catch (e) {
    console.error('[scheduler] erreur globale:', e.message);
  } finally {
    schedulerRunning = false;
  }
}

async function processPendingLead(entry) {
  const finalize = (result) => {
    pendingLeads = pendingLeads.filter(l => !(l.interestId === entry.interestId && l.receivedAt === entry.receivedAt));
    savePending();
    processedLeads.push({
      ...result,
      interestId: entry.interestId,
      leadId: entry.leadId,
      programId: entry.programId,
      receivedAt: entry.receivedAt,
      checkAt: entry.checkAt,
      processedAt: new Date().toISOString(),
    });
    saveProcessed();
  };

  entry.attempts = (entry.attempts || 0) + 1;
  savePending();

  try {
    // 1. Récupérer le lead (avec include=interests si supporté) — sert pour les contacts et potentiellement pour lire l'interest embarqué
    const lead = await fetchLead(entry.leadId);
    console.log(`[debug] lead ${entry.leadId} — keys: ${Object.keys(lead || {}).join(',')}`);
    // Essaie plusieurs variantes de nommage pour le sous-champ interests
    const maybeInterestsArr = lead?.interests || lead?.interest || lead?.program_interests || lead?.programs || null;
    if (Array.isArray(maybeInterestsArr)) {
      console.log(`[debug] lead.interests array length=${maybeInterestsArr.length}, premier element keys: ${Object.keys(maybeInterestsArr[0] || {}).join(',')}`);
    } else {
      console.log(`[debug] pas de champ interests/programs trouvé dans le lead`);
    }

    // 2. Récupérer l'interest — plusieurs sources possibles
    //    (a) via lead.interests si l'include a marché
    //    (b) via /interests/X ou /programs/X/interests/X ou /leads/X/interests/X
    //    (c) fallback: depuis le rawPayload du webhook (figé à T0 mais contient tout ce qu'on a besoin)
    let interest = findInterest(lead, entry.interestId);
    let interestSource = interest ? 'lead.interests' : null;
    if (!interest) {
      try {
        interest = await fetchInterest(entry.interestId, {
          programId: entry.programId,
          leadId: entry.leadId,
        });
        if (interest) interestSource = 'api';
      } catch (e) {
        console.log(`[fetchInterest] tous les endpoints ont échoué: ${e.message}`);
      }
    }
    if (!interest) {
      // Fallback final : utiliser le payload original du webhook
      interest = entry.rawPayload?.data || null;
      if (interest) interestSource = 'rawPayload (webhook T0)';
    }
    if (!interest) {
      return finalize({
        id: entry.interestId,
        status: 'error',
        error: `Interest ${entry.interestId} introuvable (aucune source disponible)`,
      });
    }
    console.log(`[debug] interest ${entry.interestId} (source=${interestSource}) — keys: ${Object.keys(interest).join(',')} — status=${interest.status}`);

    // Détection "commercial a pris la main"
    //   - Soit le status de l'interest n'est plus "to-process" (si on a pu le relire)
    //   - Soit le lead a eu une interaction postérieure à receivedAt (fallback quand rawPayload est figé)
    let commercialActed = false;
    let reason = '';
    if (interestSource !== 'rawPayload (webhook T0)' && interest.status && interest.status !== 'to-process') {
      commercialActed = true;
      reason = `Statut interest = "${interest.status}"`;
    } else if (lead.last_interaction_at && entry.receivedAt) {
      const li = new Date(lead.last_interaction_at).getTime();
      const rc = new Date(entry.receivedAt).getTime();
      if (li > rc + 60_000) { // marge 1 min pour ignorer l'événement de création
        commercialActed = true;
        reason = `last_interaction_at (${lead.last_interaction_at}) postérieur à receivedAt (${entry.receivedAt})`;
      }
    }
    if (commercialActed) {
      console.log(`[process] lead ${entry.leadId} / interest ${entry.interestId} — commercial a agi: ${reason} → on n'envoie pas`);
      return finalize({
        id: entry.interestId,
        status: 'cancelled',
        reason,
        contactName: lead.contacts?.[0]?.fullname || '',
        email: lead.contacts?.[0]?.email_primary || '',
        programId: entry.programId,
        programName: interest.program?.name || '',
      });
    }

    const contact = (lead.contacts || [])[0];
    if (!contact) {
      return finalize({ id: entry.interestId, status: 'skipped', error: 'Aucun contact sur le lead' });
    }
    const email = contact.email_primary || contact.email1 || contact.email2;
    if (!email) {
      return finalize({
        id: entry.interestId,
        status: 'skipped',
        error: 'Contact sans email',
        contactName: contact.fullname || '',
      });
    }

    if (contact.optout_email === true) {
      console.log(`[process] lead ${entry.leadId} — optout_email → on n'envoie pas`);
      return finalize({
        id: entry.interestId,
        status: 'optout',
        reason: 'Contact optout_email',
        contactName: contact.fullname || '',
        email,
      });
    }

    // Résoudre le nom du programme : d'abord depuis l'interest, sinon via fetchProgram
    let programApi = interest.program || null;
    let programName = programApi?.name || null;
    if (!programName && entry.programId) {
      programApi = await fetchProgram(entry.programId);
      programName = programApi?.name || programApi?.nom_commercial || null;
    }
    if (!programName) programName = `Programme #${entry.programId}`;

    // Lookup programme dans programmes.json (keyé par nom) → accroche personnalisée
    const programme = findProgramme(programName);
    const ville = (programme && programme.ville) || programApi?.city || programApi?.ville || '';
    const promoteur = (programme && programme.promoteur) || programApi?.developer?.name || programApi?.promoteur || '';
    const accroche = (programme && programme.accroche) || '';

    const ctx = {
      salutation: buildSalutation(contact),
      programme: programName,
      ville,
      promoteur,
      accroche_programme: accroche,
      lien_rdv: CONFIG.BOOKING_URL,
    };

    const subject = buildEmailSubject(ctx);
    const htmlBody = buildEmailBody(ctx);

    await sendEmailViaPowerAutomate(email, subject, htmlBody);
    console.log(`[process] ✅ email envoyé à ${email} — "${subject}" (accroche: ${accroche ? 'oui' : 'non'})`);

    // ── MAJ Adlead post-envoi : statut "En attente de contact" + action "Relance J+1 envoyée"
    //    Chaque appel est isolé dans son try/catch : une erreur Adlead ne doit PAS
    //    invalider le succès de l'envoi email.
    let adleadUpdateError = null;
    let adleadActionError = null;
    try {
      await updateLeadStatusPending(entry.programId, entry.leadId);
      console.log(`[process] ✅ statut Adlead lead ${entry.leadId} → "pending" (En attente de contact)`);
    } catch (e) {
      adleadUpdateError = e.message;
      console.error(`[process] ⚠️ échec MAJ statut Adlead lead ${entry.leadId}: ${e.message}`);
    }
    try {
      await createRelanceEvent(entry.programId, entry.leadId);
      console.log(`[process] ✅ event "E-mail envoyé" créé sur lead ${entry.leadId} (Relance J+1)`);
    } catch (e) {
      adleadActionError = e.message;
      console.error(`[process] ⚠️ échec création event Adlead lead ${entry.leadId}: ${e.message}`);
    }

    return finalize({
      id: entry.interestId,
      status: 'sent',
      contactName: contact.fullname || '',
      email,
      subject,
      emailBody: htmlBody,
      programId: entry.programId,
      programName,
      accrocheUsed: !!accroche,
      adleadUpdateError,
      adleadActionError,
    });
  } catch (err) {
    console.error(`[process] erreur interest ${entry.interestId}:`, err.message);
    if (entry.attempts >= (entry.maxAttempts || 3)) {
      return finalize({
        id: entry.interestId,
        status: 'error',
        error: err.message,
      });
    }
    entry.checkAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    savePending();
  }
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    pending: pendingLeads.length,
    processed: processedLeads.length,
    programmes: Object.keys(PROGRAMMES).length,
  });
});

app.get('/api/leads', (req, res) => {
  res.json(processedLeads.slice().reverse());
});

app.get('/api/pending', (req, res) => {
  res.json(pendingLeads.slice().reverse());
});

// Stats agrégées pour le dashboard temps réel
app.get('/api/stats', (req, res) => {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  // 14 derniers jours en buckets (ordre chronologique, plus ancien → plus récent)
  const byDayMap = {};
  const byDay = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const key = d.toISOString().slice(0, 10);
    const bucket = { date: key, sent: 0, cancelled: 0, optout: 0, skipped: 0, error: 0 };
    byDayMap[key] = bucket;
    byDay.push(bucket);
  }

  const counts = { sent: 0, cancelled: 0, optout: 0, skipped: 0, error: 0 };
  const byProgram = {};
  const today = { sent: 0, cancelled: 0, optout: 0, total: 0 };
  const week = { sent: 0, cancelled: 0, optout: 0, total: 0 };

  for (const l of processedLeads) {
    const st = l.status || 'skipped';
    if (counts[st] !== undefined) counts[st] += 1;

    const dayKey = (l.processedAt || '').slice(0, 10);
    if (byDayMap[dayKey] && byDayMap[dayKey][st] !== undefined) {
      byDayMap[dayKey][st] += 1;
    }

    const processedAge = now - new Date(l.processedAt || 0).getTime();
    if (processedAge < DAY) {
      today.total += 1;
      if (today[st] !== undefined) today[st] += 1;
    }
    if (processedAge < 7 * DAY) {
      week.total += 1;
      if (week[st] !== undefined) week[st] += 1;
    }

    if (l.programName) {
      byProgram[l.programName] = (byProgram[l.programName] || 0) + 1;
    }
  }

  const recent = processedLeads.slice(-20).reverse().map(l => ({
    id: l.id,
    status: l.status,
    email: (l.email || '').replace(/(.{2}).*(@.*)/, '$1***$2'),
    program: l.programName || '',
    processed_at: l.processedAt,
    created_at: l.createdAt,
  }));

  res.json({
    pending: pendingLeads.length,
    total: processedLeads.length,
    programmes: Object.keys(PROGRAMMES).length,
    counts,
    today,
    week,
    byDay,
    byProgram,
    recent,
  });
});

app.post('/api/scheduler/run', async (req, res) => {
  await schedulerTick();
  res.json({ triggered: true, pending: pendingLeads.length });
});

// Endpoint de test : appelle directement les helpers Adlead (sans envoi email, sans délai).
// Usage : POST /api/test/adlead-update?programId=X&leadId=Y
// Permet de vérifier les deux appels API Adlead sans repasser par le pipeline complet.
app.post('/api/test/adlead-update', async (req, res) => {
  const programId = req.query.programId || req.body?.programId;
  const leadId = req.query.leadId || req.body?.leadId;
  if (!programId || !leadId) {
    return res.status(400).json({ error: 'programId et leadId requis (query ou body)' });
  }
  const result = { programId, leadId, putStatus: null, postEvent: null, errors: {} };
  try {
    result.putStatus = await updateLeadStatusPending(programId, leadId);
  } catch (e) {
    result.errors.put = e.message;
  }
  try {
    result.postEvent = await createRelanceEvent(programId, leadId);
  } catch (e) {
    result.errors.post = e.message;
  }
  const ok = !result.errors.put && !result.errors.post;
  res.status(ok ? 200 : 500).json(result);
});

// Probe multiple candidate endpoints pour trouver ceux qui fonctionnent avec la clé API.
// Usage : GET /api/test/adlead-probe?programId=X&leadId=Y
app.get('/api/test/adlead-probe', async (req, res) => {
  const programId = req.query.programId || '686';
  const leadId = req.query.leadId || '77143';
  const base = `${CONFIG.ADLEAD_API_BASE}/${CONFIG.ADLEAD_TENANT}`;
  const headers = {
    'X-API-Key': CONFIG.ADLEAD_API_KEY,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  const probes = [
    // GET probes (read-only, safe)
    { tag: 'GET lead',                method: 'GET', path: `/programs/${programId}/leads/${leadId}` },
    { tag: 'GET lead records',        method: 'GET', path: `/programs/${programId}/leads/${leadId}/records` },
    { tag: 'GET lead events',         method: 'GET', path: `/programs/${programId}/leads/${leadId}/events` },
    { tag: 'GET lead activities',     method: 'GET', path: `/programs/${programId}/leads/${leadId}/activities` },
    { tag: 'GET lead sales-actions',  method: 'GET', path: `/programs/${programId}/leads/${leadId}/sales-actions` },
    { tag: 'GET lead interests',      method: 'GET', path: `/programs/${programId}/leads/${leadId}/interests` },
  ];

  const results = [];
  for (const p of probes) {
    try {
      const r = await fetch(`${base}${p.path}`, { method: p.method, headers });
      const t = await r.text();
      results.push({ ...p, status: r.status, body: t.slice(0, 200) });
    } catch (e) {
      results.push({ ...p, error: e.message });
    }
  }
  res.json({ base, programId, leadId, results });
});

app.post('/webhook/adlead', (req, res) => {
  if (!verifyAdleadSignature(req)) {
    console.warn('[webhook] Signature invalide');
    return res.status(401).json({ error: 'Signature invalide' });
  }

  const { event } = req.body || {};
  console.log(`[webhook] Événement reçu: ${event}`);

  if (event !== 'interest:created') {
    return res.status(200).json({ message: 'Événement ignoré' });
  }

  res.status(200).json({ message: 'Reçu, en attente de traitement' });

  try {
    enqueueLead(req.body);
  } catch (err) {
    console.error('[webhook] Erreur enqueue:', err.message);
  }
});

// ─── START ──────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${CONFIG.PORT}`);
  console.log(`   Délai d'attente   : ${CONFIG.DELAY_HOURS}h`);
  console.log(`   Scheduler tick    : ${CONFIG.SCHEDULER_INTERVAL_MS / 1000}s`);
  console.log(`   Programmes        : ${Object.keys(PROGRAMMES).length}`);
  console.log(`   Leads en attente  : ${pendingLeads.length}`);
  console.log(`   Leads traités     : ${processedLeads.length}`);
});

setInterval(schedulerTick, CONFIG.SCHEDULER_INTERVAL_MS);
schedulerTick().catch(e => console.error('[scheduler] tick initial:', e.message));
