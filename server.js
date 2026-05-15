const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const inboxWatcher = require('./inboxWatcher');

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
  INTERNAL_NOTIF_EMAIL:  process.env.INTERNAL_NOTIF_EMAIL || 'norman.dadon@catella.com',
  // Numéro WhatsApp de Norman au format E164 (ex: +33612345678) — pour notif
  // urgente "lead traité, pose une action Adlead". En plus du mail interne, un
  // WhatsApp court est envoyé à ce numéro à chaque envoi sortant. Norman doit
  // avoir fait join du sandbox Twilio (= recevoir des WhatsApp depuis +14155238886).
  INTERNAL_NOTIF_PHONE:  process.env.INTERNAL_NOTIF_PHONE || '',
  // Active l'envoi du mail récap "Réponse client reçue" via webhook PA.
  // false par défaut car Norman s'en fout : son besoin urgent c'est la notif
  // "lead traité, pose une action Adlead" (sendInternalNotif), pas la classification
  // de la réponse. Passer à true si on veut ré-activer.
  REPLY_NOTIF_ENABLED:   process.env.REPLY_NOTIF_ENABLED === 'true',
  ADLEAD_UI_BASE:        process.env.ADLEAD_UI_BASE || 'https://crm.adlead.immo/catella',
  BOOKING_URL:           process.env.BOOKING_URL || 'https://outlook.office.com/bookwithme/user/923d6c795e8a44b8b1703578fea6c819@catella.com/meetingtype/61-yOXWp3EmR-JEFDg44vA2?anonymous',
  DELAY_HOURS:           Number(process.env.DELAY_HOURS || 24),
  SCHEDULER_INTERVAL_MS: Number(process.env.SCHEDULER_INTERVAL_MS || 5 * 60 * 1000),
  // Liste d'IDs de programmes (CSV) où Norman est le commercial et traite lui-même
  // les leads immédiatement. Pour ces programmes :
  //   - checkAt = maintenant (traitement au prochain tick scheduler, < 5 min)
  //   - force = true (bypass check "commercial a pris la main")
  INSTANT_PROGRAM_IDS:   String(process.env.INSTANT_PROGRAM_IDS || '')
                           .split(',')
                           .map(s => s.trim())
                           .filter(Boolean),
  // Liste d'IDs de programmes (CSV) EXCLUS des relances automatiques.
  //   - À l'arrivée du webhook : le lead n'est PAS enqueue (= jamais traité)
  //   - Pour les leads déjà en queue avant l'ajout à la liste : skip au traitement
  //     avec status='excluded' (lisible côté dashboard pour audit).
  // Modifiable à chaud depuis Railway sans push de code.
  EXCLUDED_PROGRAM_IDS:  String(process.env.EXCLUDED_PROGRAM_IDS || '')
                           .split(',')
                           .map(s => s.trim())
                           .filter(Boolean),
  // ── WhatsApp via Twilio ──────────────────────────────────────────────────
  // Phase 1 (sandbox) : TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886"
  //   → destinataires doivent avoir joint le sandbox (ex: "join fence-cutting")
  // Phase 2 (prod)    : TWILIO_WHATSAPP_FROM = "whatsapp:+33XXXXXXXXX" (numéro dédié Meta)
  //   → nécessite templates approuvés côté Meta
  // WHATSAPP_ENABLED = 'true' pour activer ; sinon kill switch (aucun envoi tenté).
  TWILIO_ACCOUNT_SID:    process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN:     process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_WHATSAPP_FROM:  process.env.TWILIO_WHATSAPP_FROM || '',
  WHATSAPP_ENABLED:      process.env.WHATSAPP_ENABLED === 'true',
  // ContentSid Twilio du template Meta "relance_j1_catella" (ex: HX1e7f...).
  // Si vide → envoi en mode Body (sandbox / hors templates) avec wording legacy
  //   buildWhatsAppMessage(). Marche uniquement pour numéros opted-in au sandbox.
  // Si défini → envoi en mode ContentSid+ContentVariables (templates Meta-approved).
  //   Variables : {{1}} = prénom, {{2}} = nom du programme.
  // À renseigner sur Railway dès que le template passe "Approved" côté Meta.
  TWILIO_TEMPLATE_RELANCE_J1: process.env.TWILIO_TEMPLATE_RELANCE_J1 || '',
  // ── Relance J+15 (récupération de leads en stagnation) ───────────────────
  // Cron quotidien qui relance les leads dont le statut Adlead est "pending"
  // ("En attente de contact") et dont la dernière action commerciale date de
  // plus de J15_DELAY_DAYS jours. Kill switch global via J15_ENABLED.
  // WhatsApp J+15 gated indépendamment via WHATSAPP_J15_ENABLED + TWILIO_TEMPLATE_RELANCE_J15.
  J15_ENABLED:           process.env.J15_ENABLED === 'true',
  J15_DELAY_DAYS:        Number(process.env.J15_DELAY_DAYS || 15),
  J15_CRON_HOUR_PARIS:   Number(process.env.J15_CRON_HOUR_PARIS || 10),
  TWILIO_TEMPLATE_RELANCE_J15: process.env.TWILIO_TEMPLATE_RELANCE_J15 || '',
  WHATSAPP_J15_ENABLED:  process.env.WHATSAPP_J15_ENABLED === 'true',
  // Kill switch BELT-AND-SUSPENDERS pour les envois J+15 : si true, AUCUN
  // sendEmail / sendWhatsApp ne peut partir depuis le code path J+15, même
  // si J15_ENABLED=true et même en mode "réel" (pas dry-run). À utiliser
  // pour valider le code en prod sans risque d'envoi indu. Ajouté après
  // l'incident 2026-05-15 (mon /api/test/j15-dry-run envoyait pour de vrai).
  J15_SEND_DISABLED:     process.env.J15_SEND_DISABLED === 'true',
  // ── Relance J+3 du matin (3 jours consécutifs après passage en "pending") ──
  // Cron quotidien à 9h15 Paris qui relance les leads dont le statut Adlead
  // est passé à "pending" depuis ≥24h, avec 3 messages d'escalation :
  //   Jour 1 : email "doux"     ("Petit point sur votre demande")
  //   Jour 2 : WhatsApp "moyen" (template approved Meta, fallback email si pas dispo)
  //   Jour 3 : email "final"    ("Dernier point avant de classer")
  // Stop dès que lead.status ≠ "pending" (= prospect a répondu OU Norman a re-statué).
  J3M_ENABLED:           process.env.J3M_ENABLED === 'true',
  J3M_SEND_DISABLED:     process.env.J3M_SEND_DISABLED === 'true',
  J3M_CRON_HOUR_PARIS:   Number(process.env.J3M_CRON_HOUR_PARIS || 9),
  J3M_CRON_MIN_MINUTE:   Number(process.env.J3M_CRON_MIN_MINUTE || 15),
  WHATSAPP_J3M_ENABLED:  process.env.WHATSAPP_J3M_ENABLED === 'true',
  // ContentSid Twilio du template Meta "relance_j3m_day2_catella" (jour 2 = WhatsApp).
  // Si vide → fallback email pour le jour 2 (ne casse pas le cycle).
  TWILIO_TEMPLATE_J3M_DAY2: process.env.TWILIO_TEMPLATE_J3M_DAY2 || '',
  // Webhook Twilio "incoming WhatsApp" : Twilio nous POSTe à /webhook/whatsapp-incoming
  // dès qu'un prospect répond sur notre numéro WhatsApp Business. On le secure par
  // signature Twilio HMAC (X-Twilio-Signature) — pas d'env var requis (le secret est
  // l'AUTH_TOKEN Twilio déjà configuré). TWILIO_VALIDATE_SIGNATURE=false pour bypass
  // en dev/debug uniquement.
  TWILIO_VALIDATE_SIGNATURE: process.env.TWILIO_VALIDATE_SIGNATURE !== 'false',
  // ── Notifications Telegram (canal "urgent" Norman) ─────────────────────────
  // Bot créé via @BotFather → @Catella_notif_bot. Token = TELEGRAM_BOT_TOKEN.
  // Norman a démarré la conversation avec /start → son chat_id = TELEGRAM_CHAT_ID.
  // Le bot poste des notifs courtes (HTML) à 2 occasions :
  //   - Lead traité par le pipeline (sendInternalNotif) → "lead sent → action Adlead urgente"
  //   - Réponse WhatsApp prospect (/webhook/whatsapp-incoming) → "réponse → action Adlead"
  // Canal redondant avec mail Gmail + WhatsApp Twilio interne. But : ne JAMAIS rater une
  // notif urgente, et garder une trace dans l'historique conversationnel Telegram.
  // TELEGRAM_NOTIF_ENABLED=false pour kill switch global (idem que INTERNAL_NOTIF_DISABLED
  // mais ciblé Telegram seulement, utile si on veut bypass Telegram tout en gardant mail).
  TELEGRAM_BOT_TOKEN:      process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID:        process.env.TELEGRAM_CHAT_ID || '',
  TELEGRAM_NOTIF_ENABLED:  process.env.TELEGRAM_NOTIF_ENABLED !== 'false',
  // ── Tag Adlead "Relance J+1 envoyée" ─────────────────────────────────────
  // L'API Adlead /tags exige un UUID de tag pré-créé dans l'admin (côté
  // responsable marketing). Doc : https://docs.adlead.immo/v1/tags.html
  // Si TAG_UUID_RELANCE_J1 vide → on skippe silencieusement la pose du tag.
  // Pour activer : créer un tag "Relance J+1 envoyée" dans Adlead, copier l'UUID,
  //                le coller dans cette env var Railway.
  TAG_UUID_RELANCE_J1: process.env.TAG_UUID_RELANCE_J1 || '',
  // ── Mise à jour statut lead Adlead "pending" (en attente de contact) ──────
  // Doc Adlead n'expose PAS encore d'endpoint PATCH/PUT pour modifier le statut
  // d'un lead (Cédric, 22/04/2026 : "Cette route n'existe pas encore mais sera
  // disponible d'ici cet été"). On tente quand même un PATCH best-effort sur
  // /leads/{id} → si l'API n'expose pas, on récupère 404/405 et on log.
  // STATUS_UPDATE_ENABLED=false pour désactiver complètement les tentatives
  // (limiter les logs d'erreur tant que la route n'existe pas).
  STATUS_UPDATE_ENABLED: process.env.STATUS_UPDATE_ENABLED !== 'false',
  // ── Reply handler (Graph device-code + Claude) ───────────────────────────
  // ANTHROPIC_API_KEY        : clé API pour l'appel Claude Sonnet
  // ANTHROPIC_MODEL          : id modèle (default claude-sonnet-4-6)
  // REPLY_HANDLER_ENABLED    : master switch — si false, poll() ne fait rien
  // REPLY_POLL_INTERVAL_MS   : fréquence poll inbox (default 3 min)
  ANTHROPIC_API_KEY:       process.env.ANTHROPIC_API_KEY || '',
  ANTHROPIC_MODEL:         process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  REPLY_HANDLER_ENABLED:   process.env.REPLY_HANDLER_ENABLED === 'true',
  REPLY_POLL_INTERVAL_MS:  Number(process.env.REPLY_POLL_INTERVAL_MS || 3 * 60 * 1000),
  // ── Webhook Power Automate "Reply Watcher" ───────────────────────────────
  // Reçoit les réponses prospect via un flow PA "Lorsqu'un nouveau message arrive".
  // Permet de bypasser la policy Conditional Access Catella (qui bloque l'auth
  // Graph directe car notre IP serveur n'est pas un device Catella enregistré).
  // Le flow PA POSTe vers /webhook/inbox-reply avec le header X-PA-Secret.
  POWER_AUTOMATE_INBOX_SECRET: process.env.POWER_AUTOMATE_INBOX_SECRET || '',
  // ── Dénonciation : DÉSACTIVÉ par défaut (Cédric Adlead, 22/04/2026) ───────
  // Adlead filtre désormais les leads dénoncés à la SOURCE : leur webhook ne
  // nous envoie plus les leads avec une dénonciation active sur le programme.
  // De plus, la clé API #223 a été restreinte (plus d'accès /registrations).
  // → Le check côté nous est devenu redondant ET cassé (403 sur l'endpoint).
  // → Default = bypass complet du check. Pour réactiver malgré tout, passer
  //   explicitement SKIP_REGISTRATIONS_CHECK=false en env var.
  SKIP_REGISTRATIONS_CHECK: process.env.SKIP_REGISTRATIONS_CHECK !== 'false',
  // ── Kill switches d'urgence ───────────────────────────────────────────────
  // INTERNAL_NOTIF_DISABLED : si true, on n'envoie AUCUN mail interne à Norman
  //   (ni sendInternalNotif ni sendFailClosedNotif). Les mails aux prospects
  //   partent quand même si le pipeline passe le check dénonciation. Utile
  //   quand les notifs fail-closed spamment la boîte pendant qu'Adlead n'a pas
  //   encore activé le scope registrations:read.
  INTERNAL_NOTIF_DISABLED: process.env.INTERNAL_NOTIF_DISABLED === 'true',
  // PIPELINE_DISABLED : option nucléaire — le scheduler tick ne traite plus
  //   aucun lead. Le webhook continue à encaisser (rien n'est perdu), mais
  //   ni mail prospect ni notif interne ni WhatsApp ne partent.
  PIPELINE_DISABLED: process.env.PIPELINE_DISABLED === 'true',
  PORT:                  process.env.PORT || 3000,
};

// ─── RUNTIME STATS (compteurs process — non persistés) ─────────────────────
// Utilisés par /api/stats pour le dashboard. Remis à 0 au boot ; pas besoin de
// persister, ce sont des indicateurs de santé "depuis le dernier redémarrage".
const RUNTIME_STATS = {
  registrationsFailClosed: 0, // leads bloqués parce que /registrations inaccessible
};

// Set pour lookup O(1) dans enqueueLead
const INSTANT_PROGRAM_SET = new Set(CONFIG.INSTANT_PROGRAM_IDS);
if (INSTANT_PROGRAM_SET.size > 0) {
  console.log(`[config] Programmes en envoi IMMÉDIAT (sans délai 24h): ${[...INSTANT_PROGRAM_SET].join(', ')}`);
} else {
  console.log(`[config] Aucun programme en envoi immédiat — tous les leads attendent ${CONFIG.DELAY_HOURS}h`);
}

// Set des programIds exclus complètement des relances automatiques
const EXCLUDED_PROGRAM_SET = new Set(CONFIG.EXCLUDED_PROGRAM_IDS);
if (EXCLUDED_PROGRAM_SET.size > 0) {
  console.log(`[config] Programmes EXCLUS des relances auto: ${[...EXCLUDED_PROGRAM_SET].join(', ')}`);
}

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
// DATA_DIR : configurable via env DATA_DIR (Railway Volume monté sur /data p.ex.).
// Fallback : ./data à côté du server.js (utile en dev local).
// ATTENTION : sur Railway sans Volume attaché, /app/data est ÉPHÉMÈRE — la file
// sera wipée à chaque redéploiement. Attacher un Volume dans Railway et pointer
// DATA_DIR vers son mount path (ex: /data) pour une vraie persistance.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const PENDING_FILE = path.join(DATA_DIR, 'pending_leads.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed_leads.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Vérifie au démarrage que DATA_DIR est accessible en écriture
function checkDataDirWritable() {
  try {
    ensureDataDir();
    const probe = path.join(DATA_DIR, '.write-probe');
    fs.writeFileSync(probe, String(Date.now()), 'utf8');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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

// Check filesystem writability AVANT de charger — si ça échoue on saura pourquoi
const _dirCheck = checkDataDirWritable();
if (_dirCheck.ok) {
  console.log(`[persistence] DATA_DIR=${DATA_DIR} OK (writable)`);
} else {
  console.error(`[persistence] ⚠️  DATA_DIR=${DATA_DIR} NON ACCESSIBLE EN ÉCRITURE: ${_dirCheck.error}`);
  console.error(`[persistence] ⚠️  La file ne sera PAS persistée — corriger avant la prod.`);
}

let pendingLeads = loadJsonFile(PENDING_FILE, []);
let processedLeads = loadJsonFile(PROCESSED_FILE, []);

// ─── INBOX WATCHER (réponses prospect) ──────────────────────────────────────
// Initialisé ici (après DATA_DIR check) — le module gère son propre state en JSON
// dans DATA_DIR/relance_tracking.json + replies_processed.json + graph-token.json.
// Il ne fait RIEN au démarrage — poll() n'est déclenché que par schedulerInboxTick().
try {
  inboxWatcher.init({
    config: CONFIG,
    dataDir: DATA_DIR,
    helpers: {
      adleadPost: (p, body) => adleadPost(p, body),
    },
  });
} catch (e) {
  console.error(`[inboxWatcher] init échec (non bloquant): ${e.message}`);
}

console.log(`[persistence] Chargé au démarrage: ${pendingLeads.length} lead(s) en attente, ${processedLeads.length} lead(s) traité(s)`);
if (pendingLeads.length > 0) {
  const nextDue = pendingLeads
    .map(l => new Date(l.checkAt).getTime())
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b)[0];
  if (nextDue) {
    const delta = Math.round((nextDue - Date.now()) / 60000);
    console.log(`[persistence] Prochain check dans ~${delta} minute(s) (${new Date(nextDue).toISOString()})`);
  }
}

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

// PATCH best-effort. L'API Adlead v1 n'expose PAS officiellement de route de mise à jour
// d'un lead (Cédric, 22/04/2026 : "Cette route n'existe pas encore mais sera disponible
// d'ici cet été"). On tente quand même — si la route n'existe pas, on récupère 404/405,
// on log silencieusement et on continue. Dès que Cédric livre la route, le code marchera
// sans modif (STATUS_UPDATE_ENABLED=true par défaut).
async function adleadPatch(path, body) {
  const url = `${CONFIG.ADLEAD_API_BASE}/${CONFIG.ADLEAD_TENANT}${path}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'X-API-Key': CONFIG.ADLEAD_API_KEY,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Adlead API PATCH ${res.status} ${res.statusText} on ${path}: ${text.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => ({}));
  return json.data || json;
}

// Pose un tag (UUID) sur un lead via POST /programs/{pid}/leads/{lid}/tags.
// Doc : https://docs.adlead.immo/v1/tags.html
// Le tag doit être pré-créé dans l'admin Adlead (côté responsable marketing) — l'UUID
// est ensuite injecté en env var TAG_UUID_RELANCE_J1.
// Si l'UUID n'est pas configuré, on skip silencieusement.
async function addTagToLead(programId, leadId, tagUuid, isGlobal = false) {
  if (!tagUuid) {
    return { skipped: true, reason: 'TAG_UUID non configuré' };
  }
  return adleadPost(`/programs/${programId}/leads/${leadId}/tags`, {
    tag_uuid: tagUuid,
    is_global: isGlobal,
  });
}

// Met à jour le statut d'un lead Adlead.
// Statuts valides : to-process, pending, to-follow, ongoing, interested, negotiating,
//                   discarded, pending-purchaser, purchaser
// (cf https://docs.adlead.immo/v1/leads.html#statut-d-un-lead)
// Best-effort : la route PATCH n'est pas officiellement documentée. Si elle retourne
// 404/405 → throw qu'on attrape côté appelant.
async function updateLeadStatusAdlead(programId, leadId, statusKey) {
  if (!CONFIG.STATUS_UPDATE_ENABLED) {
    return { skipped: true, reason: 'STATUS_UPDATE_ENABLED=false' };
  }
  return adleadPatch(`/programs/${programId}/leads/${leadId}`, {
    status: statusKey,
  });
}

// Créer une sales-action "Traité - Relance J+1" sur le lead (colonne SUIVI COMMERCIAL Adlead)
//   Endpoint : POST /programs/{pid}/leads/{lid}/sales-actions
//   NB: endpoint /records (colonne Événements) PAS exposé via X-API-Key → on utilise /sales-actions.
async function createRelanceSalesAction(programId, leadId) {
  // Body conforme à la doc officielle v1 : https://docs.adlead.immo/v1/salesActions.html
  //   - type = "send-email" (valeur valide dans l'énumération documentée)
  //   - scheduled_at au format ISO 8601 UTC, doit être dans le futur → now + 5 min
  //   - priority & comment optionnels
  const now = new Date();
  const future = new Date(now.getTime() + 5 * 60 * 1000);
  const scheduled_at = future.toISOString().replace('Z', '').replace(/\.\d{3}$/, '.000000') + 'Z';
  const today = now.toLocaleDateString('fr-FR');
  return adleadPost(`/programs/${programId}/leads/${leadId}/sales-actions`, {
    type: 'send-email',
    scheduled_at,
    priority: 'medium',
    comment: `Traité — Relance automatique J+1 envoyée le ${today}`,
  });
}

// Notification interne à Norman : après l'envoi auto du mail client, on lui envoie
// un mail "à la main" avec le lien Adlead du lead à traiter manuellement
// (puisque la MAJ statut et la création d'event côté Adlead sont bloquées via l'API).
function buildAdleadLeadUrl(programId, leadId) {
  return `${CONFIG.ADLEAD_UI_BASE}/programs/${programId}/contact-management/leads/${leadId}`;
}

async function sendInternalNotif({ programId, leadId, contactName, contactEmail, programName }) {
  if (CONFIG.INTERNAL_NOTIF_DISABLED) {
    console.log(`[internal-notif] DÉSACTIVÉ via INTERNAL_NOTIF_DISABLED — skip lead ${leadId}`);
    return;
  }
  const to = CONFIG.INTERNAL_NOTIF_EMAIL;
  const when = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  const adleadUrl = buildAdleadLeadUrl(programId, leadId);
  const subject = `[Catella — Relance auto] ${programName || 'Programme inconnu'} — ${contactName || contactEmail}`;
  const html = `
<!doctype html>
<html lang="fr"><body style="font-family: Arial, sans-serif; font-size: 14px; color: #222; line-height: 1.55;">
  <p>Bonjour Norman,</p>
  <p>Un lead a été relancé automatiquement à <strong>${when}</strong> et reste à traiter dans Adlead :</p>
  <ul style="list-style: none; padding-left: 0;">
    <li>• <strong>Contact</strong> : ${contactName || '(nom inconnu)'}</li>
    <li>• <strong>Email</strong> : ${contactEmail || '(email inconnu)'}</li>
    <li>• <strong>Programme</strong> : ${programName || '(programme inconnu)'}</li>
    <li>• <strong>Lien Adlead</strong> : <a href="${adleadUrl}">${adleadUrl}</a></li>
  </ul>
  <p>Merci de poser l'action "E-mail envoyé" dans la timeline du lead.</p>
  <p style="color: #888; font-size: 12px;">— Pipeline Catella Lead Automation</p>
</body></html>`;
  // 1. Mail interne (Gmail Norman). On NE bloque pas si ça échoue.
  try {
    await sendEmailViaPowerAutomate(to, subject, html);
  } catch (e) {
    console.error(`[internal-notif] échec mail Gmail lead ${leadId}: ${e.message}`);
  }
  // 2. Notif WhatsApp à Norman lui-même (canal redondant pour pas rater le ping).
  //    Best-effort : si le WhatsApp Twilio échoue, le mail Gmail est censé suffire.
  if (CONFIG.WHATSAPP_ENABLED && CONFIG.INTERNAL_NOTIF_PHONE) {
    try {
      const waBody =
        `🚨 Lead traité auto — ACTION ADLEAD URGENTE\n` +
        `Programme : ${programName || 'inconnu'}\n` +
        `Contact : ${contactName || contactEmail || 'inconnu'}\n` +
        `→ ${adleadUrl}\n` +
        `(Pose une action Adlead avant qu'un autre vendeur ne te vole le lead.)`;
      const resp = await sendWhatsAppViaTwilio(CONFIG.INTERNAL_NOTIF_PHONE, waBody);
      console.log(`[internal-notif] ✅ WhatsApp ping envoyé à ${CONFIG.INTERNAL_NOTIF_PHONE} (sid: ${resp?.sid || 'n/a'}) — lead ${leadId}`);
    } catch (e) {
      console.error(`[internal-notif] ⚠️ WhatsApp ping échec lead ${leadId}: ${e.message}`);
    }
  } else if (!CONFIG.INTERNAL_NOTIF_PHONE) {
    console.log(`[internal-notif] (info) INTERNAL_NOTIF_PHONE non configuré → pas de WhatsApp ping. Lead ${leadId}.`);
  }
  // 3. Notif Telegram à Norman (canal urgent supplémentaire, indispensable à terme
  //    quand le WhatsApp interne ne marchera plus en prod Meta sans template approuvé).
  if (CONFIG.TELEGRAM_NOTIF_ENABLED && CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
    try {
      const txt =
        `🚨 <b>Lead traité auto — ACTION ADLEAD URGENTE</b>\n\n` +
        `• <b>Programme</b> : ${escapeTelegramHtml(programName || 'inconnu')}\n` +
        `• <b>Contact</b> : ${escapeTelegramHtml(contactName || contactEmail || 'inconnu')}\n` +
        `• <b>Email</b> : <code>${escapeTelegramHtml(contactEmail || 'n/a')}</code>\n\n` +
        `→ <a href="${adleadUrl}">Ouvrir dans Adlead</a>\n\n` +
        `<i>Pose une action Adlead avant qu'un autre vendeur ne te vole le lead.</i>`;
      const resp = await sendTelegramNotification(txt);
      console.log(`[internal-notif] ✅ Telegram envoyé (message_id: ${resp?.result?.message_id || 'n/a'}) — lead ${leadId}`);
    } catch (e) {
      console.error(`[internal-notif] ⚠️ Telegram échec lead ${leadId}: ${e.message}`);
    }
  }
}

// Notif interne envoyée quand un lead est BLOQUÉ par le fail-closed dénonciation
// (le pipeline n'a pas pu vérifier si le lead est dénoncé, donc n'envoie RIEN).
// Objectif : Norman va traiter manuellement — soit constater la dénonciation et
// laisser tomber, soit envoyer lui-même la relance si le lead est sain.
async function sendFailClosedNotif({ programId, leadId, contactName, contactEmail, programName, reason, receivedAt }) {
  if (CONFIG.INTERNAL_NOTIF_DISABLED) {
    console.log(`[fail-closed-notif] DÉSACTIVÉ via INTERNAL_NOTIF_DISABLED — skip lead ${leadId}`);
    return;
  }
  const to = CONFIG.INTERNAL_NOTIF_EMAIL;
  const when = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  const adleadUrl = buildAdleadLeadUrl(programId, leadId);
  // Âge du lead depuis réception webhook (utile pour prioriser le traitement)
  let ageTxt = '';
  if (receivedAt) {
    const ageMs = Date.now() - new Date(receivedAt).getTime();
    const ageH = Math.round(ageMs / (60 * 60 * 1000));
    ageTxt = ` (reçu il y a ~${ageH}h)`;
  }
  const subject = `⚠️ [Catella — À TRAITER] ${programName || 'Programme inconnu'} — ${contactName || contactEmail}${ageTxt}`;
  const html = `
<!doctype html>
<html lang="fr"><body style="font-family: Arial, sans-serif; font-size: 14px; color: #222; line-height: 1.55;">
  <p>Bonjour Norman,</p>
  <p>Un lead arrivé au scheduler à <strong>${when}</strong> <strong>n'a pas été relancé automatiquement</strong> car le check dénonciation est en fail-closed (l'API Adlead <code>/registrations</code> est inaccessible, probablement en attente du scope <code>registrations:read</code>).</p>
  <p>👉 <strong>Tu dois traiter ce lead manuellement</strong> — vérifier dans Adlead s'il est dénoncé :
    <ul style="list-style: none; padding-left: 0;">
      <li>• Si <strong>dénoncé</strong> → ne rien faire, le prescripteur le prend en charge.</li>
      <li>• Si <strong>pas dénoncé</strong> → envoie-lui un mail de relance manuellement depuis Outlook.</li>
    </ul>
  </p>
  <p><strong>Détails du lead :</strong></p>
  <ul style="list-style: none; padding-left: 0;">
    <li>• <strong>Contact</strong> : ${contactName || '(nom inconnu)'}</li>
    <li>• <strong>Email</strong> : ${contactEmail || '(email inconnu)'}</li>
    <li>• <strong>Programme</strong> : ${programName || '(programme inconnu)'}</li>
    <li>• <strong>Reçu le</strong> : ${receivedAt || '(inconnu)'}${ageTxt}</li>
    <li>• <strong>Lien Adlead</strong> : <a href="${adleadUrl}">${adleadUrl}</a></li>
  </ul>
  <p style="color: #666; font-size: 12px;"><em>Raison du blocage : ${reason || 'fail-closed dénonciation'}</em></p>
  <p style="color: #888; font-size: 12px;">Pour lever ce blocage : passer <code>SKIP_REGISTRATIONS_CHECK=true</code> dans les env vars Railway (bypass d'urgence) ou attendre qu'Adlead active le scope <code>registrations:read</code> sur la clé API.</p>
  <p style="color: #888; font-size: 12px;">— Pipeline Catella Lead Automation</p>
</body></html>`;
  return sendEmailViaPowerAutomate(to, subject, html);
}

async function fetchLead(leadId, { programId } = {}) {
  // PRIORITÉ : endpoint contextualisé /programs/{pid}/leads/{lid} qui renvoie
  // le lead COMPLET (avec status, is_under_prescription, discard_reason — clés
  // métier critiques pour le check robuste dénonciation/statut).
  // L'endpoint global /leads/{id} (sans programId) avec la clé API restreinte
  // par Cédric (22/04/2026) renvoie un lead partiel sans ces champs → check
  // dénonciation aveugle. Cf. INCIDENT-2026-05-06.md.
  if (programId) {
    try {
      return await adleadGet(`/programs/${programId}/leads/${leadId}?include=interests,interests.program,contacts`);
    } catch (e) {
      try {
        return await adleadGet(`/programs/${programId}/leads/${leadId}`);
      } catch (e2) {
        // Fallback final sur l'endpoint global (peut être partiel)
        return adleadGet(`/leads/${leadId}`);
      }
    }
  }
  // Pas de programId connu : on tente l'endpoint global avec includes, fallback nu.
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

// Liste les dénonciations (registrations) d'un programme.
// Pagination : on récupère jusqu'à 3 pages x 100 pour couvrir l'historique récent
// (une dénonciation expire en ~1 mois donc seules les récentes sont "actives").
//
// Retourne { ok, regs, status, error } au lieu d'un simple array, pour que
// l'appelant puisse distinguer "0 dénonciation" d'un "endpoint inaccessible".
// - ok=true  : appel API réussi, regs contient les lignes (éventuellement [])
// - ok=false : 4xx/5xx/body invalide/network error → on NE PEUT PAS conclure
//              que le lead n'est pas dénoncé (fail-closed côté appelant).
async function fetchProgramRegistrations(programId, { maxPages = 3 } = {}) {
  if (!programId) return { ok: true, regs: [], status: null, error: null };
  const all = [];
  let firstStatus = null;
  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${CONFIG.ADLEAD_API_BASE}/${CONFIG.ADLEAD_TENANT}/programs/${programId}/registrations?page=${page}&per_page=100`;
      const res = await fetch(url, {
        headers: { 'X-API-Key': CONFIG.ADLEAD_API_KEY, 'Accept': 'application/json' },
      });
      if (firstStatus === null) firstStatus = res.status;
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        console.log(`[registrations] GET page ${page} programme ${programId} → ${res.status} ${t.slice(0, 150)}`);
        // Si c'est la 1re page qui échoue, on remonte un fail-closed. Si une
        // page ultérieure échoue on a déjà au moins les premières dénonciations
        // en mémoire — on préfère encore renvoyer ok:false par prudence car
        // on ne peut pas affirmer avoir la totalité.
        return { ok: false, regs: all, status: res.status, error: `HTTP ${res.status}: ${t.slice(0, 150)}` };
      }
      const json = await res.json();
      // Adlead peut renvoyer {success:false, message:"..."} avec un HTTP 200
      // dans certains cas anciens — on traite ça comme un échec.
      if (json && json.success === false) {
        const msg = json.message || 'success:false';
        console.log(`[registrations] GET page ${page} programme ${programId} → body success=false: ${String(msg).slice(0, 150)}`);
        return { ok: false, regs: all, status: res.status, error: `body success:false — ${String(msg).slice(0, 150)}` };
      }
      const data = Array.isArray(json.data) ? json.data : [];
      all.push(...data);
      const lastPage = json?.meta?.last_page || 1;
      if (page >= lastPage) break;
    } catch (e) {
      console.log(`[registrations] erreur page ${page} programme ${programId}: ${e.message}`);
      return { ok: false, regs: all, status: firstStatus, error: e.message };
    }
  }
  return { ok: true, regs: all, status: firstStatus, error: null };
}

// Extrait l'id du lead depuis une registration Adlead en couvrant toutes les
// formes plausibles renvoyées par l'API (snake_case, camelCase, objet imbriqué).
// Utile parce que selon la version/endpoint Adlead peut exposer :
//   { lead_id: 123 }                  ou
//   { leadId: 123 }                   ou
//   { lead: { id: 123 } }             ou
//   { lead: 123 }                     (id direct)
// Si AUCUN de ces champs n'est numérique, on remonte NaN → pas de match silencieux.
function extractLeadIdFromRegistration(r) {
  if (!r) return NaN;
  const candidates = [
    r.lead_id,
    r.leadId,
    r.lead && typeof r.lead === 'object' ? r.lead.id : r.lead,
    r.lead_uid,
    r.lead_ref,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return NaN;
}

// Vrai si le lead a une dénonciation "bloquante" active sur le programme :
//   - status pending  (en cours d'arbitrage → on attend, donc on skip)
//   - status approved ET expires_at > maintenant
// (rejected/expired ne bloquent pas)
//
// Retourne :
//   - null                          → pas de dénonciation bloquante (safe, on envoie)
//   - { ... registration Adlead }   → dénonciation trouvée (on skip)
//   - { _failClosed: true, status,
//       error }                     → endpoint inaccessible, on skip par prudence
//                                     (sauf si CONFIG.SKIP_REGISTRATIONS_CHECK=true)
async function findActiveRegistrationForLead(programId, leadId) {
  if (!programId || !leadId) return null;
  const result = await fetchProgramRegistrations(programId);

  // ── Fail-closed : si on n'a pas pu lister les registrations (403, network,
  // body success:false, etc.), on NE PEUT PAS affirmer que le lead n'est pas
  // dénoncé. Par défaut on bloque. Bypass possible via SKIP_REGISTRATIONS_CHECK.
  if (!result.ok) {
    if (CONFIG.SKIP_REGISTRATIONS_CHECK) {
      console.warn(`[registrations] ⚠️  endpoint inaccessible (statut=${result.status}, error=${result.error}) MAIS SKIP_REGISTRATIONS_CHECK=true → on laisse passer le lead ${leadId} (programme ${programId})`);
      return null;
    }
    RUNTIME_STATS.registrationsFailClosed += 1;
    console.log(`[registrations] BLOQUÉ (endpoint inaccessible): lead ${leadId} programme ${programId}, statut=${result.status}, error=${result.error}`);
    return {
      _failClosed: true,
      status: result.status,
      error: result.error,
    };
  }

  const regs = result.regs;
  const now = Date.now();
  const leadIdNum = Number(leadId);

  // Observabilité : on log systématiquement la distribution pour ce programme
  // (avant de filtrer par lead) — indispensable pour détecter un shift de schéma
  // côté Adlead (ex: `lead_id` → `lead.id`) qui rendrait le filtre aveugle.
  const matchingForLead = regs.filter(r => extractLeadIdFromRegistration(r) === leadIdNum);
  const firstKeys = regs[0] ? Object.keys(regs[0]).join(',') : '(aucune registration)';
  console.log(`[registrations] programme ${programId} / lead ${leadId}: ${regs.length} reg(s) total, ${matchingForLead.length} match lead — schema keys du premier: ${firstKeys}`);
  if (matchingForLead.length > 0) {
    const summary = matchingForLead.map(r => `#${r.id}:${r.status}${r.expires_at ? `(exp=${r.expires_at})` : ''}`).join(', ');
    console.log(`[registrations] lead ${leadId} → registrations trouvées: ${summary}`);
  }

  const match = matchingForLead.find(r => {
    if (r.status === 'pending') return true;
    if (r.status === 'approved') {
      if (!r.expires_at) return true; // approuvée sans date → considère active
      return new Date(r.expires_at).getTime() > now;
    }
    return false;
  });
  return match || null;
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

// ─── ENVOI WHATSAPP VIA TWILIO ──────────────────────────────────────────────
// Sandbox : le destinataire doit avoir envoyé "join <code>" au numéro sandbox.
// Prod    : templates Meta approuvés requis pour messages sortants hors fenêtre 24h.

function normalizePhoneE164(raw, defaultCountryCode = '33') {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  if (digits.startsWith('0')) return '+' + defaultCountryCode + digits.slice(1);
  return '+' + digits;
}

/**
 * Envoie un message WhatsApp via l'API Twilio.
 *
 * Deux modes :
 *  - Mode "Body" (legacy / sandbox / notifs internes) : on passe `body` en texte
 *    libre. Twilio l'envoie tel quel. Marche pour les destinataires sandbox-joined,
 *    et pour les conversations DÉJÀ ouvertes (session 24h après dernier message
 *    du prospect). Ne marche PAS en cold-outreach sur numéro Meta-approved : Meta
 *    rejette tout message hors-template envoyé en initiation de conversation.
 *  - Mode "ContentSid" (prod Meta) : on passe `options.templateSid` + `options.contentVariables`.
 *    Twilio résout le template approuvé Meta (id HX...) et substitue les variables.
 *    C'est le SEUL mode autorisé pour ouvrir une conversation en prod Meta.
 *
 * Backward-compatible : tous les appels actuels `sendWhatsAppViaTwilio(phone, body)`
 * continuent de fonctionner en mode Body (sans options).
 *
 * @param {string} toE164 — Numéro destinataire au format E164 (+33...)
 * @param {string} body — Texte à envoyer en mode Body. Ignoré si options.templateSid présent.
 * @param {object} [options] — Options avancées
 * @param {string} [options.templateSid] — ContentSid Twilio (ex: HX1e7f...) → bascule en mode template
 * @param {object} [options.contentVariables] — Mapping {"1": "Jean", "2": "Programme XYZ"}
 * @returns {Promise<object>} — Réponse Twilio JSON (contient .sid)
 */
async function sendWhatsAppViaTwilio(toE164, body, options = {}) {
  if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN || !CONFIG.TWILIO_WHATSAPP_FROM) {
    throw new Error('Credentials Twilio non configurés');
  }
  const auth = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams();
  params.append('From', CONFIG.TWILIO_WHATSAPP_FROM);
  params.append('To',   `whatsapp:${toE164}`);
  if (options.templateSid) {
    // Mode ContentSid : Body est ignoré côté Twilio quand ContentSid est présent.
    params.append('ContentSid', options.templateSid);
    if (options.contentVariables) {
      params.append('ContentVariables', JSON.stringify(options.contentVariables));
    }
  } else {
    // Mode Body legacy (sandbox / notifs internes).
    params.append('Body', body);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Twilio ${res.status}: ${err.slice(0, 200)}`);
  }
  return await res.json();
}

/**
 * Envoie une notification Telegram à Norman via le bot @Catella_notif_bot.
 * Best-effort : ne bloque pas le caller si Telegram est down ou mal configuré.
 *
 * Format : par défaut parse_mode=HTML pour permettre <b>, <i>, <a>, <code> dans le text.
 * Notif sonore par défaut (disable_notification=false). Pour notif silencieuse,
 * passer { silent: true }.
 *
 * @param {string} text — Texte du message (max 4096 chars Telegram).
 * @param {object} [options]
 * @param {string} [options.parseMode] — 'HTML' (défaut) | 'MarkdownV2' | 'Markdown'
 * @param {boolean} [options.silent] — true → notif silencieuse (no sound on phone)
 * @returns {Promise<object|null>} — Réponse Telegram API (null si désactivé)
 */
async function sendTelegramNotification(text, options = {}) {
  if (!CONFIG.TELEGRAM_NOTIF_ENABLED) return null;
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    throw new Error('Telegram non configuré (TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant)');
  }
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: CONFIG.TELEGRAM_CHAT_ID,
    text: text.slice(0, 4096), // hard cap Telegram
    parse_mode: options.parseMode || 'HTML',
    disable_web_page_preview: options.disableWebPagePreview !== false,
    disable_notification: options.silent === true,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Telegram ${res.status}: ${err.slice(0, 200)}`);
  }
  return await res.json();
}

// Helper : escape HTML pour passer dans Telegram en parse_mode HTML.
// Telegram HTML accepte seulement <b>, <i>, <u>, <s>, <a>, <code>, <pre>, <tg-spoiler>,
// <blockquote>. Toutes les autres balises doivent être escapées.
function escapeTelegramHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildWhatsAppMessage(ctx) {
  const firstname = splitName(ctx.fullname || '').firstname || '';
  const hello = firstname ? `Bonjour ${firstname}` : 'Bonjour';
  const villePart = ctx.ville ? ` à ${ctx.ville}` : '';
  return `${hello}, Norman Dadon de Catella Residential.

Vous vous êtes intéressé(e) à notre programme « ${ctx.programme} »${villePart}. J'aimerais comprendre votre recherche : typologie, étage, budget ?

Répondez-moi ici, ou prenez 5 min à votre convenance : ${ctx.lien_rdv}

Bien à vous,
Norman`;
}

// ─── FLOW PRINCIPAL ─────────────────────────────────────────────────────────

function enqueueLead(payload) {
  const data = payload.data || {};
  const interestId = data.id;
  const leadId = data.lead_id || data.leadId || data.context?.lead_id;
  const programId = data.program_id || data.programId || data.context?.program_id;

  // EXCLUSION : si le programme est dans EXCLUDED_PROGRAM_IDS, on n'enqueue PAS
  // (= jamais traité, jamais d'envoi). Configurable à chaud côté Railway.
  if (programId && EXCLUDED_PROGRAM_SET.has(String(programId))) {
    console.log(`[enqueue] Lead ${leadId} (programme ${programId}) IGNORÉ — programme dans EXCLUDED_PROGRAM_IDS`);
    return null;
  }

  // Envoi immédiat si le programme est dans INSTANT_PROGRAM_IDS
  // (cas : Norman est lui-même le commercial sur ce programme, pas besoin d'attendre 24h)
  const isInstant = programId && INSTANT_PROGRAM_SET.has(String(programId));
  const checkAt = isInstant
    ? new Date().toISOString()
    : new Date(Date.now() + CONFIG.DELAY_HOURS * 60 * 60 * 1000).toISOString();

  const entry = {
    interestId,
    leadId,
    programId,
    receivedAt: new Date().toISOString(),
    checkAt,
    rawPayload: payload,
    attempts: 0,
    maxAttempts: 3,
    // Si programme instant : bypass le check "commercial a pris la main"
    // (puisque TU es le commercial et que tu n'auras pas agi en quelques secondes)
    force: isInstant ? true : undefined,
    instant: isInstant ? true : undefined,
  };

  pendingLeads.push(entry);
  savePending();
  if (isInstant) {
    console.log(`[enqueue] Lead ${leadId} (programme ${programId} INSTANT) — envoi au prochain tick scheduler (< ${Math.round(CONFIG.SCHEDULER_INTERVAL_MS / 1000)}s)`);
    // Déclenche un tick immédiat pour ne pas attendre l'intervalle complet
    setImmediate(() => schedulerTick().catch(e => console.error('[enqueue→tick] erreur:', e.message)));
  } else {
    console.log(`[enqueue] Lead ${leadId} (interest ${interestId}) en attente — check à ${entry.checkAt}`);
  }
  return entry;
}

let schedulerRunning = false;

async function schedulerTick() {
  if (schedulerRunning) return;
  // Kill switch global : PIPELINE_DISABLED=true → aucun traitement, les leads
  // restent dans la file d'attente sans être consommés. Le webhook continue à
  // encaisser de nouveaux leads normalement.
  if (CONFIG.PIPELINE_DISABLED) {
    // Log une fois par tick mais pas à chaque lead pour ne pas polluer
    console.log(`[scheduler] PIPELINE_DISABLED=true → tick ignoré (${pendingLeads.length} lead(s) en attente)`);
    return;
  }
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

  // EXCLUSION programmes : rattrape les leads déjà en queue dont le programme
  // a été ajouté à EXCLUDED_PROGRAM_IDS après l'enqueue. On ne traite pas, on
  // marque comme 'excluded' pour audit côté dashboard.
  if (entry.programId && EXCLUDED_PROGRAM_SET.has(String(entry.programId))) {
    console.log(`[process] lead ${entry.leadId} programme ${entry.programId} dans EXCLUDED_PROGRAM_IDS → skip définitif`);
    return finalize({
      id: entry.interestId,
      status: 'excluded',
      reason: `Programme ${entry.programId} dans EXCLUDED_PROGRAM_IDS`,
      programId: entry.programId,
    });
  }

  entry.attempts = (entry.attempts || 0) + 1;
  savePending();

  try {
    // 1. Récupérer le lead via l'endpoint CONTEXTUALISÉ /programs/{pid}/leads/{lid}
    //    qui renvoie le lead COMPLET (status, is_under_prescription, discard_reason).
    //    Indispensable pour le check robuste dénonciation/statut plus bas.
    const lead = await fetchLead(entry.leadId, { programId: entry.programId });
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
    //   entry.force === true bypass ce check (utilisé par /api/test/process-now).
    let commercialActed = false;
    let reason = '';
    if (entry.force) {
      console.log(`[process] entry.force=true → on bypass le check commercialActed`);
    } else if (interestSource !== 'rawPayload (webhook T0)' && interest.status && interest.status !== 'to-process') {
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

    // ── CHECK ROBUSTE DÉNONCIATION/STATUT — fail-closed côté lead ────────────
    // S'applique TOUJOURS (même si entry.force=true) car c'est une règle métier
    // critique : on ne doit JAMAIS envoyer une relance auto sur un lead :
    //   (1) marqué is_under_prescription=true → revendiqué par un prescripteur
    //       (= dénonciation activée côté Adlead, indépendamment de /registrations)
    //   (2) avec un status ≠ "to-process" → un commercial l'a déjà fait avancer
    //       (statuts Adlead : pending, to-follow, ongoing, interested, negotiating,
    //        discarded, pending-purchaser, purchaser → tous bloquants)
    //   (3) avec un discard_reason non null → mis hors-jeu pour une raison quelconque
    //
    // Ce check repose UNIQUEMENT sur les champs renvoyés par GET /leads/{id}
    // (que la clé API actuelle peut consulter, on l'a vérifié), donc il est
    // robuste face au scope retiré sur /registrations. Cf. doc Adlead :
    // https://docs.adlead.immo/v1/leads.html#statut-d-un-lead
    let leadBlocked = false;
    let blockReason = '';
    let blockStatusKey = 'cancelled';
    if (lead.is_under_prescription === true) {
      leadBlocked = true;
      blockReason = 'Lead sous prescription (is_under_prescription=true)';
      blockStatusKey = 'denounced';
    } else if (lead.status && lead.status !== 'to-process') {
      leadBlocked = true;
      blockReason = `Lead statut Adlead = "${lead.status}" (≠ to-process, voir doc Adlead statuts)`;
      blockStatusKey = lead.status === 'discarded' ? 'cancelled' : 'cancelled';
    } else if (lead.discard_reason) {
      leadBlocked = true;
      blockReason = `Lead discardé (discard_reason=${lead.discard_reason})`;
    }
    if (leadBlocked) {
      console.log(`[process] lead ${entry.leadId} BLOQUÉ par check robuste : ${blockReason} → on n'envoie pas (status=${blockStatusKey})`);
      return finalize({
        id: entry.interestId,
        status: blockStatusKey,
        reason: blockReason,
        contactName: lead.contacts?.[0]?.fullname || '',
        email: lead.contacts?.[0]?.email_primary || '',
        programId: entry.programId,
        programName: interest.program?.name || '',
        leadStatus: lead.status || null,
        isUnderPrescription: lead.is_under_prescription === true,
        discardReason: lead.discard_reason || null,
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

    // ── Scan OBSERVATIONNEL du payload lead ──────────────────────────────────
    // Non bloquant : on log juste la présence éventuelle d'un champ de
    // dénonciation directement sur l'objet lead. Si un jour on voit apparaître
    // "[denounced-scan] … signaux potentiels trouvés → denounced=true" dans les
    // logs Railway, on saura quel champ exploiter et on pourra promouvoir ce
    // scan en check bloquant dans un commit ultérieur.
    try {
      scanLeadForDenouncedSignals(lead, { verbose: true });
    } catch (e) {
      console.log(`[denounced-scan] erreur (non bloquant): ${e.message}`);
    }

    // ── Check DÉNONCIATION (règle métier critique) ───────────────────────────
    // Si une dénonciation active (pending ou approved non-expirée) existe sur ce
    // lead pour ce programme, c'est que l'ERP/un prescripteur a revendiqué le lead
    // pour une vente directe : on ne relance PAS (ni email ni WhatsApp).
    try {
      const activeReg = await findActiveRegistrationForLead(entry.programId, entry.leadId);
      if (activeReg && activeReg._failClosed) {
        // Endpoint /registrations inaccessible → fail-closed : on skip le lead
        // pour ne pas risquer d'envoyer sur une dénonciation qu'on aurait
        // manquée. Bypass via SKIP_REGISTRATIONS_CHECK=true (voir CONFIG).
        console.log(`[process] lead ${entry.leadId} SKIP fail-closed (registrations inaccessible, statut=${activeReg.status})`);
        // Notif interne à Norman pour qu'il aille traiter manuellement le lead
        // (vérifier dénonciation dans Adlead, et envoyer la relance à la main si OK).
        // Best-effort : on n'empêche pas le finalize si l'envoi du mail plante.
        const programNameForNotif = interest?.program?.name || `Programme #${entry.programId}`;
        try {
          await sendFailClosedNotif({
            programId: entry.programId,
            leadId: entry.leadId,
            contactName: contact.fullname || '',
            contactEmail: email,
            programName: programNameForNotif,
            reason: activeReg.error || `HTTP ${activeReg.status}`,
            receivedAt: entry.receivedAt,
          });
          console.log(`[process] ✅ notif fail-closed envoyée à ${CONFIG.INTERNAL_NOTIF_EMAIL} (lead ${entry.leadId})`);
        } catch (e) {
          console.error(`[process] ⚠️ envoi notif fail-closed échec lead ${entry.leadId}: ${e.message}`);
        }
        return finalize({
          id: entry.interestId,
          status: 'skipped',
          reason: `Check dénonciation fail-closed (endpoint /registrations statut=${activeReg.status}: ${activeReg.error || 'inaccessible'}). Bypass: SKIP_REGISTRATIONS_CHECK=true.`,
          contactName: contact.fullname || '',
          email,
          programId: entry.programId,
          programName: programNameForNotif,
          registrationsFailClosed: true,
          registrationsFailClosedStatus: activeReg.status,
        });
      }
      if (activeReg) {
        const expires = activeReg.expires_at || 'n/a';
        const ownerName = activeReg.owner?.fullname || activeReg.owner?.shortname || 'inconnu';
        console.log(`[process] lead ${entry.leadId} DÉNONCÉ (registration ${activeReg.id}, status=${activeReg.status}, owner=${ownerName}, expires=${expires}) → on n'envoie pas`);
        return finalize({
          id: entry.interestId,
          status: 'denounced',
          reason: `Dénonciation ${activeReg.status} par ${ownerName} (registration ${activeReg.id}, expire ${expires})`,
          contactName: contact.fullname || '',
          email,
          programId: entry.programId,
          registrationId: activeReg.id,
          registrationStatus: activeReg.status,
          registrationOwner: ownerName,
          registrationExpiresAt: activeReg.expires_at,
        });
      }
    } catch (e) {
      // Exception imprévue dans la chaîne de check → fail-closed aussi.
      // On préfère bloquer que laisser passer : un lead dénoncé envoyé = client
      // perdu + risque métier. Bypass : SKIP_REGISTRATIONS_CHECK=true.
      console.error(`[process] ⚠️ check dénonciation EXCEPTION lead ${entry.leadId}: ${e.message}`);
      if (!CONFIG.SKIP_REGISTRATIONS_CHECK) {
        RUNTIME_STATS.registrationsFailClosed += 1;
        console.log(`[registrations] BLOQUÉ (exception): lead ${entry.leadId} programme ${entry.programId}, error=${e.message}`);
        const programNameForNotif = interest?.program?.name || `Programme #${entry.programId}`;
        try {
          await sendFailClosedNotif({
            programId: entry.programId,
            leadId: entry.leadId,
            contactName: contact.fullname || '',
            contactEmail: email,
            programName: programNameForNotif,
            reason: `exception: ${e.message}`,
            receivedAt: entry.receivedAt,
          });
          console.log(`[process] ✅ notif fail-closed envoyée à ${CONFIG.INTERNAL_NOTIF_EMAIL} (lead ${entry.leadId})`);
        } catch (err2) {
          console.error(`[process] ⚠️ envoi notif fail-closed échec lead ${entry.leadId}: ${err2.message}`);
        }
        return finalize({
          id: entry.interestId,
          status: 'skipped',
          reason: `Check dénonciation fail-closed (exception: ${e.message}). Bypass: SKIP_REGISTRATIONS_CHECK=true.`,
          contactName: contact.fullname || '',
          email,
          programId: entry.programId,
          programName: programNameForNotif,
          registrationsFailClosed: true,
        });
      }
      console.warn(`[process] SKIP_REGISTRATIONS_CHECK=true → on continue malgré l'exception sur lead ${entry.leadId}`);
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

    // ── Tracking pour le reply handler : on garde (leadId, programId, email, sujet, sentAt)
    //    pour matcher plus tard les réponses du prospect. Non bloquant si ça plante.
    try {
      inboxWatcher.registerSentRelance({
        leadId: entry.leadId,
        programId: entry.programId,
        contactEmail: email,
        contactName: contact.fullname || '',
        programName,
        subject,
      });
    } catch (e) {
      console.error(`[process] ⚠️ registerSentRelance échec (non bloquant): ${e.message}`);
    }

    // ── Notif interne à Norman : mail avec lien Adlead pour qu'il pose l'action à la main
    //    (l'API v1 Adlead n'expose pas d'endpoint pour modifier un lead / créer un event
    //    dans la colonne Événements — voir docs.adlead.immo/v1/leads.html).
    let internalNotifError = null;
    try {
      await sendInternalNotif({
        programId: entry.programId,
        leadId: entry.leadId,
        contactName: contact.fullname || '',
        contactEmail: email,
        programName,
      });
      console.log(`[process] ✅ notif interne envoyée à ${CONFIG.INTERNAL_NOTIF_EMAIL} (lead ${entry.leadId})`);
    } catch (e) {
      internalNotifError = e.message;
      console.error(`[process] ⚠️ échec notif interne lead ${entry.leadId}: ${e.message}`);
    }

    // ── Best-effort sales-action Adlead (si un jour l'API se débloque, on aura la trace
    //    auto en bonus — pour l'instant ça échoue en 500 mais c'est silencieux et non bloquant).
    let adleadActionError = null;
    try {
      await createRelanceSalesAction(entry.programId, entry.leadId);
      console.log(`[process] ✅ sales-action Adlead créée sur lead ${entry.leadId}`);
    } catch (e) {
      adleadActionError = e.message;
      // Silencieux en prod : on log en debug seulement pour pas polluer les logs à chaque lead.
      console.log(`[process] (info) sales-action Adlead échec best-effort lead ${entry.leadId}: ${e.message.slice(0, 120)}`);
    }

    // ── Best-effort pose tag Adlead "Relance J+1 envoyée"
    //    Si TAG_UUID_RELANCE_J1 non configuré → skip silencieux (Norman doit créer le
    //    tag dans l'admin Adlead et coller l'UUID dans Railway).
    let tagPosted = false;
    let tagError = null;
    if (CONFIG.TAG_UUID_RELANCE_J1) {
      try {
        await addTagToLead(entry.programId, entry.leadId, CONFIG.TAG_UUID_RELANCE_J1, false);
        tagPosted = true;
        console.log(`[process] ✅ tag Relance J+1 posé sur lead ${entry.leadId}`);
      } catch (e) {
        tagError = e.message;
        console.error(`[process] ⚠️ pose tag échec lead ${entry.leadId}: ${e.message.slice(0, 200)}`);
      }
    }

    // ── Best-effort PATCH statut lead → "pending" (= "En attente de contact")
    //    Cédric : "Cette route n'existe pas encore mais sera disponible d'ici cet été".
    //    On tente quand même — si 404/405, on log silencieusement, ça marchera dès livraison.
    let statusUpdated = false;
    let statusError = null;
    if (CONFIG.STATUS_UPDATE_ENABLED) {
      try {
        await updateLeadStatusAdlead(entry.programId, entry.leadId, 'pending');
        statusUpdated = true;
        console.log(`[process] ✅ statut lead ${entry.leadId} → pending`);
      } catch (e) {
        statusError = e.message;
        // Silencieux : la route n'est pas censée exister aujourd'hui (404 attendu).
        console.log(`[process] (info) PATCH statut échec lead ${entry.leadId}: ${e.message.slice(0, 150)}`);
      }
    }

    // ── Best-effort WhatsApp via Twilio (non bloquant, gated par WHATSAPP_ENABLED)
    //    Phase 1 = sandbox : destinataire doit avoir joint le sandbox au préalable.
    //    Phase 2 = prod    : templates Meta approuvés requis.
    let whatsappError = null;
    let whatsappSid   = null;
    let whatsappTo    = null;
    if (CONFIG.WHATSAPP_ENABLED) {
      const phoneRaw = contact.phone_primary
                    || contact.phone1
                    || contact.mobile_primary
                    || contact.mobile
                    || contact.phone_mobile
                    || null;
      const phoneE164 = normalizePhoneE164(phoneRaw);
      if (!phoneE164) {
        whatsappError = 'pas de téléphone sur le contact';
        console.log(`[process] (info) WhatsApp skip lead ${entry.leadId}: ${whatsappError}`);
      } else if (contact.optout_sms === true || contact.optout_phone === true) {
        whatsappError = 'optout téléphone/sms';
        console.log(`[process] (info) WhatsApp skip lead ${entry.leadId}: ${whatsappError}`);
      } else {
        whatsappTo = phoneE164;
        try {
          // Mode prod Meta (ContentSid) si template configuré ; sinon fallback body (sandbox).
          // Le template "relance_j1_catella" attend : {{1}} = prénom, {{2}} = nom du programme.
          // Le body legacy buildWhatsAppMessage reste construit (utilisé en fallback Twilio
          // si le template est absent côté Railway, et utile pour debug/logging).
          const firstname = splitName(contact.fullname || '').firstname || '';
          const body = buildWhatsAppMessage({
            fullname: contact.fullname || '',
            programme: programName,
            ville,
            lien_rdv: CONFIG.BOOKING_URL,
          });
          const sendOptions = CONFIG.TWILIO_TEMPLATE_RELANCE_J1 ? {
            templateSid: CONFIG.TWILIO_TEMPLATE_RELANCE_J1,
            contentVariables: {
              "1": firstname || 'bonjour',  // fallback si pas de prénom (rare mais possible)
              "2": programName || 'votre projet',
            },
          } : {};
          const resp = await sendWhatsAppViaTwilio(phoneE164, body, sendOptions);
          whatsappSid = resp && resp.sid ? resp.sid : null;
          const mode = CONFIG.TWILIO_TEMPLATE_RELANCE_J1 ? 'template' : 'body';
          console.log(`[process] ✅ WhatsApp envoyé à ${phoneE164} (mode: ${mode}, sid: ${whatsappSid})`);
        } catch (e) {
          whatsappError = e.message;
          console.error(`[process] ⚠️ WhatsApp échec ${phoneE164} lead ${entry.leadId}: ${e.message}`);
        }
      }
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
      internalNotifError,
      adleadActionError,
      whatsappEnabled: CONFIG.WHATSAPP_ENABLED,
      whatsappTo,
      whatsappSid,
      whatsappError,
      tagPosted,
      tagError,
      statusUpdated,
      statusError,
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
  const dirCheck = checkDataDirWritable();
  let pendingFileStat = null, processedFileStat = null;
  try { pendingFileStat = fs.statSync(PENDING_FILE); } catch {}
  try { processedFileStat = fs.statSync(PROCESSED_FILE); } catch {}
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    pending: pendingLeads.length,
    processed: processedLeads.length,
    programmes: Object.keys(PROGRAMMES).length,
    config: {
      delayHours: CONFIG.DELAY_HOURS,
      schedulerIntervalMs: CONFIG.SCHEDULER_INTERVAL_MS,
      instantProgramIds: [...INSTANT_PROGRAM_SET],
      j15Enabled: CONFIG.J15_ENABLED,
      j15DelayDays: CONFIG.J15_DELAY_DAYS,
      j15CronHourParis: CONFIG.J15_CRON_HOUR_PARIS,
      j15WhatsappEnabled: CONFIG.WHATSAPP_J15_ENABLED,
      j15TemplateConfigured: !!CONFIG.TWILIO_TEMPLATE_RELANCE_J15,
      j3mEnabled: CONFIG.J3M_ENABLED,
      j3mSendDisabled: CONFIG.J3M_SEND_DISABLED,
      j3mCronHourParis: CONFIG.J3M_CRON_HOUR_PARIS,
      j3mWhatsappEnabled: CONFIG.WHATSAPP_J3M_ENABLED,
      j3mTemplateDay2Configured: !!CONFIG.TWILIO_TEMPLATE_J3M_DAY2,
    },
    persistence: {
      dataDir: DATA_DIR,
      dataDirFromEnv: !!process.env.DATA_DIR,
      writable: dirCheck.ok,
      writeError: dirCheck.ok ? null : dirCheck.error,
      pendingFile: {
        path: PENDING_FILE,
        exists: !!pendingFileStat,
        sizeBytes: pendingFileStat?.size || 0,
        mtime: pendingFileStat?.mtime || null,
      },
      processedFile: {
        path: PROCESSED_FILE,
        exists: !!processedFileStat,
        sizeBytes: processedFileStat?.size || 0,
        mtime: processedFileStat?.mtime || null,
      },
    },
    replyHandler: {
      enabled: CONFIG.REPLY_HANDLER_ENABLED,
      pollIntervalMs: CONFIG.REPLY_POLL_INTERVAL_MS,
      anthropicConfigured: !!CONFIG.ANTHROPIC_API_KEY,
      anthropicModel: CONFIG.ANTHROPIC_MODEL,
      graphAuthenticated: inboxWatcher.hasGraphCreds(),
      ...inboxWatcher.getStats(),
    },
  });
});

app.get('/api/leads', (req, res) => {
  res.json(processedLeads.slice().reverse());
});

app.get('/api/pending', (req, res) => {
  res.json(pendingLeads.slice().reverse());
});

// ─── ADMIN : vider la file pending ─────────────────────────────────────────
// Endpoint d'urgence pour purger les leads "pending" sans redémarrer le service.
// Utilisé p.ex. avant de réactiver le pipeline après une pause prolongée, pour
// éviter de traiter en rafale 75+ leads obsolètes (les vrais éligibles seront
// renvoyés par Adlead au prochain webhook ou refetch côté CRM).
//
// Auth : token partagé via le secret webhook Adlead (ADLEAD_WEBHOOK_SECRET).
// Pas d'env var supplémentaire à provisionner — on réutilise un secret déjà
// présent en prod. Comparaison timing-safe pour éviter les attaques par timing.
//
// Effet :
//   - retire toutes les entrées de pendingLeads
//   - les enregistre dans processedLeads avec status='cancelled' et reason
//     'admin clear-pending' pour garder une trace dans le dashboard
//   - persiste les deux fichiers (pending_leads.json, processed_leads.json)
//
// Usage :
//   curl -X POST "https://<host>/api/admin/clear-pending?token=<ADLEAD_WEBHOOK_SECRET>"
app.post('/api/admin/clear-pending', (req, res) => {
  const expected = CONFIG.ADLEAD_WEBHOOK_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'ADLEAD_WEBHOOK_SECRET non configuré côté serveur — endpoint désactivé' });
  }
  const provided = String(req.query.token || req.body?.token || '');
  // Comparaison timing-safe (longueurs alignées) — refuse aussi les tokens vides.
  let ok = false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    ok = provided.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { ok = false; }
  if (!ok) {
    return res.status(401).json({ error: 'token invalide' });
  }

  const before = pendingLeads.length;
  const now = new Date().toISOString();
  const cleared = pendingLeads.map(entry => ({
    id: entry.interestId || entry.id,
    leadId: entry.leadId,
    interestId: entry.interestId,
    programId: entry.programId,
    programName: entry.programName,
    email: entry.email,
    status: 'cancelled',
    reason: 'admin clear-pending (purge file avant redémarrage)',
    createdAt: entry.receivedAt || entry.createdAt || now,
    processedAt: now,
  }));
  // Trace dans processedLeads pour que le dashboard reflète la purge.
  processedLeads.push(...cleared);
  saveProcessed();
  // Vide la file et persiste.
  pendingLeads = [];
  savePending();

  console.log(`[admin] clear-pending : ${before} lead(s) purgés (status=cancelled, reason=admin clear-pending)`);
  res.json({
    cleared: before,
    remaining: pendingLeads.length,
    timestamp: now,
    note: 'Les leads ont été archivés dans processedLeads avec status=cancelled. ' +
          'Si Adlead repousse les mêmes leads via webhook ou si un refetch est lancé, ils seront ré-enqueue.',
    leadIds: cleared.map(l => l.leadId).filter(Boolean),
  });
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
    const bucket = {
      date: key,
      sent: 0, cancelled: 0, optout: 0, skipped: 0, error: 0, denounced: 0,
      whatsappSent: 0, whatsappError: 0,
    };
    byDayMap[key] = bucket;
    byDay.push(bucket);
  }

  const counts = { sent: 0, cancelled: 0, optout: 0, skipped: 0, error: 0, denounced: 0 };
  const whatsapp = { enabledLeads: 0, sent: 0, error: 0, skipped: 0 };
  // byProgram enrichi : pour chaque programme on stocke un objet avec le détail
  // des statuts au lieu d'un simple total, pour pouvoir afficher un mini-tableau
  // dans le dashboard (sent / denounced / failClosed / taux).
  const byProgram = {};
  const today = { sent: 0, cancelled: 0, optout: 0, denounced: 0, skipped: 0, total: 0, whatsappSent: 0, whatsappError: 0, failClosed: 0 };
  const week  = { sent: 0, cancelled: 0, optout: 0, denounced: 0, skipped: 0, total: 0, whatsappSent: 0, whatsappError: 0, failClosed: 0 };
  // Compteurs pour la santé des services externes — on scanne les leads récents
  // (< 1 h) pour détecter des erreurs Twilio / Power Automate et déduire l'état.
  const RECENT = 60 * 60 * 1000; // 1 h
  let recentProcessed = 0;
  let recentEmailErrors = 0;      // erreurs envoi email (Power Automate)
  let recentWhatsappErrors = 0;   // erreurs WhatsApp (Twilio)
  let recentWhatsappAttempts = 0;
  // Compteur spécifique fail-closed (comptant TOUS les leads marqués failClosed,
  // pas seulement ceux passés par le compteur runtime — utile après reboot).
  let totalFailClosed = 0;

  for (const l of processedLeads) {
    const st = l.status || 'skipped';
    if (counts[st] !== undefined) counts[st] += 1;

    const dayKey = (l.processedAt || '').slice(0, 10);
    if (byDayMap[dayKey] && byDayMap[dayKey][st] !== undefined) {
      byDayMap[dayKey][st] += 1;
    }

    // ── Métriques WhatsApp (best-effort, ne comptent que sur les leads 'sent')
    //    Si l'envoi a été tenté (whatsappEnabled=true ET whatsappTo renseigné) :
    //      - succès  → whatsappSid présent et pas d'erreur
    //      - erreur  → whatsappError non null
    //      - skipped → whatsappEnabled=true mais pas de téléphone / optout
    if (st === 'sent' && l.whatsappEnabled) {
      whatsapp.enabledLeads += 1;
      if (l.whatsappSid && !l.whatsappError) {
        whatsapp.sent += 1;
        if (byDayMap[dayKey]) byDayMap[dayKey].whatsappSent += 1;
      } else if (l.whatsappError) {
        whatsapp.error += 1;
        if (byDayMap[dayKey]) byDayMap[dayKey].whatsappError += 1;
      } else {
        whatsapp.skipped += 1;
      }
    }

    const processedAge = now - new Date(l.processedAt || 0).getTime();
    if (processedAge < DAY) {
      today.total += 1;
      if (today[st] !== undefined) today[st] += 1;
      if (l.registrationsFailClosed) today.failClosed += 1;
      if (st === 'sent' && l.whatsappEnabled) {
        if (l.whatsappSid && !l.whatsappError) today.whatsappSent += 1;
        else if (l.whatsappError)              today.whatsappError += 1;
      }
    }
    if (processedAge < 7 * DAY) {
      week.total += 1;
      if (week[st] !== undefined) week[st] += 1;
      if (l.registrationsFailClosed) week.failClosed += 1;
      if (st === 'sent' && l.whatsappEnabled) {
        if (l.whatsappSid && !l.whatsappError) week.whatsappSent += 1;
        else if (l.whatsappError)              week.whatsappError += 1;
      }
    }

    // Santé des services : fenêtre glissante 1 h sur les leads récents
    if (processedAge < RECENT) {
      recentProcessed += 1;
      if (st === 'error') recentEmailErrors += 1;
      if (l.whatsappEnabled) {
        recentWhatsappAttempts += 1;
        if (l.whatsappError) recentWhatsappErrors += 1;
      }
    }

    if (l.registrationsFailClosed) totalFailClosed += 1;

    if (l.programName) {
      if (!byProgram[l.programName]) {
        byProgram[l.programName] = {
          total: 0, sent: 0, cancelled: 0, optout: 0, denounced: 0, skipped: 0, error: 0, failClosed: 0,
        };
      }
      const p = byProgram[l.programName];
      p.total += 1;
      if (p[st] !== undefined) p[st] += 1;
      if (l.registrationsFailClosed) p.failClosed += 1;
    }
  }

  // ── Taux d'efficacité global : sent / leads finalisés sur décision automatique
  //    (on exclut skipped/error qui sont des "pas de décision" ou échecs techniques).
  //    Numerator = sent. Denominator = sent + cancelled + optout + denounced.
  const eligible = counts.sent + counts.cancelled + counts.optout + counts.denounced;
  const efficiencyRate = eligible > 0 ? Math.round((counts.sent / eligible) * 1000) / 10 : null;

  // ── Santé des services externes (dérivée des leads récents, sans ping direct)
  //    Règle : >=2 erreurs dans la dernière heure OU >50% d'échecs → KO.
  //    adleadRegistrations : état dérivé du compteur fail-closed.
  const buildHealth = (label, errors, attempts, degradedThreshold = 2) => {
    if (attempts === 0) return { ok: true, label, status: 'unknown', note: 'aucune donnée récente' };
    const rate = errors / attempts;
    const ok = errors < degradedThreshold && rate < 0.5;
    return {
      ok,
      label,
      status: ok ? 'healthy' : 'degraded',
      note: `${errors}/${attempts} erreurs en 1 h`,
    };
  };
  const services = {
    adleadRegistrations: {
      ok: totalFailClosed === 0 && RUNTIME_STATS.registrationsFailClosed === 0,
      label: 'Adlead — dénonciations',
      status: (totalFailClosed === 0 && RUNTIME_STATS.registrationsFailClosed === 0) ? 'healthy' : 'down',
      note: (totalFailClosed === 0 && RUNTIME_STATS.registrationsFailClosed === 0)
        ? 'endpoint /registrations accessible'
        : `fail-closed actif (${RUNTIME_STATS.registrationsFailClosed} depuis boot, ${totalFailClosed} total)`,
    },
    powerAutomate: buildHealth('Power Automate (emails)', recentEmailErrors, Math.max(recentProcessed, 1)),
    twilio: buildHealth('Twilio (WhatsApp)', recentWhatsappErrors, recentWhatsappAttempts),
  };

  const recent = processedLeads.slice(-20).reverse().map(l => ({
    id: l.id,
    leadId: l.leadId,
    programId: l.programId,
    interestId: l.interestId || l.id,
    status: l.status,
    email: (l.email || '').replace(/(.{2}).*(@.*)/, '$1***$2'),
    program: l.programName || '',
    // Raison lisible : si envoyé, null ; sinon on expose le champ le plus explicite
    // (reason > error) tronqué pour l'affichage.
    reason: l.status === 'sent' ? null : (l.reason || l.error || '').slice(0, 200),
    failClosed: !!l.registrationsFailClosed,
    processed_at: l.processedAt,
    created_at: l.createdAt,
    whatsapp: l.whatsappEnabled
      ? (l.whatsappSid && !l.whatsappError ? 'sent' : (l.whatsappError ? 'error' : 'skipped'))
      : null,
  }));

  res.json({
    pending: pendingLeads.length,
    total: processedLeads.length,
    programmes: Object.keys(PROGRAMMES).length,
    counts,
    whatsapp,
    today,
    week,
    byDay,
    byProgram,
    recent,
    efficiencyRate,
    services,
    // Santé du filtre dénonciation — si > 0, l'endpoint /registrations est
    // inaccessible (probablement clé API sans scope registrations:read) et
    // des leads ont été bloqués par le fail-closed. Cf. CONFIG.SKIP_REGISTRATIONS_CHECK.
    registrationsFailClosed: RUNTIME_STATS.registrationsFailClosed,
    registrationsFailClosedTotal: totalFailClosed,
    skipRegistrationsCheck: CONFIG.SKIP_REGISTRATIONS_CHECK,
  });
});

app.post('/api/scheduler/run', async (req, res) => {
  await schedulerTick();
  res.json({ triggered: true, pending: pendingLeads.length });
});

// Endpoint de test Telegram : envoie un message bidon pour valider le canal.
// Usage : POST /api/test/telegram (body JSON optionnel : { text: "..." })
// Réponse : { ok, telegram: <api response> } ou { ok: false, error: ... }.
app.post('/api/test/telegram', async (req, res) => {
  const text = (req.body && req.body.text) || `🧪 <b>Test Telegram</b> depuis lead-automation Railway\n\nSi tu vois ce message, le canal Telegram est OK.\n\n<i>Heure serveur : ${new Date().toISOString()}</i>`;
  try {
    const resp = await sendTelegramNotification(text);
    res.json({
      ok: true,
      enabled: CONFIG.TELEGRAM_NOTIF_ENABLED,
      hasToken: !!CONFIG.TELEGRAM_BOT_TOKEN,
      hasChatId: !!CONFIG.TELEGRAM_CHAT_ID,
      telegram: resp,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      enabled: CONFIG.TELEGRAM_NOTIF_ENABLED,
      hasToken: !!CONFIG.TELEGRAM_BOT_TOKEN,
      hasChatId: !!CONFIG.TELEGRAM_CHAT_ID,
      error: e.message,
    });
  }
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
  const result = { programId, leadId, postSalesAction: null, internalNotif: null, errors: {} };
  try {
    result.postSalesAction = await createRelanceSalesAction(programId, leadId);
  } catch (e) {
    result.errors.post = e.message;
  }
  try {
    result.internalNotif = await sendInternalNotif({
      programId, leadId,
      contactName: '(test endpoint)',
      contactEmail: '(test)',
      programName: '(test)',
    });
  } catch (e) {
    result.errors.notif = e.message;
  }
  const ok = !result.errors.notif; // sales-action erreur = normal (best-effort)
  res.status(ok ? 200 : 500).json(result);
});

// Endpoint de test : force le traitement immédiat d'un lead (bypass fenêtre 24h + queue + check commercial).
// Usage : POST /api/test/process-now?leadId=X[&interestId=Y][&programId=Z][&force=1]
// - Si interestId manquant, on fetch le lead et on prend le premier interest.
// - force=1 bypass aussi le check "commercial a déjà agi" (sinon un lead déjà traité sera 'cancelled').
// Utilisé pour valider le mail client en prod sans attendre la fenêtre de 24h.
app.post('/api/test/process-now', async (req, res) => {
  const leadId = req.query.leadId || req.body?.leadId;
  let interestId = req.query.interestId || req.body?.interestId;
  let programId = req.query.programId || req.body?.programId;
  const force = String(req.query.force || req.body?.force || '').toLowerCase() !== '0'
             && String(req.query.force || req.body?.force || '').toLowerCase() !== 'false';
  if (!leadId) {
    return res.status(400).json({ error: 'leadId requis (query ou body)' });
  }
  // Tente de déduire interestId depuis le lead ; si l'API n'expose pas les interests,
  // on fabrique un interestId synthétique et un rawPayload minimal pour que processPendingLead
  // puisse tout de même envoyer le mail client.
  if (!interestId) {
    try {
      const lead = await fetchLead(String(leadId));
      const interests = lead?.interests || lead?.interest || lead?.program_interests || lead?.programs || [];
      if (Array.isArray(interests) && interests.length > 0) {
        interestId = interests[0].id;
        if (!programId) programId = interests[0].program_id || interests[0].program?.id;
        console.log(`[process-now] interestId déduit=${interestId}, programId=${programId} (depuis lead ${leadId})`);
      } else {
        interestId = `test-synthetic-${leadId}-${Date.now()}`;
        console.log(`[process-now] aucun interest dans l'API — interestId synthétique ${interestId}`);
      }
    } catch (e) {
      interestId = `test-synthetic-${leadId}-${Date.now()}`;
      console.log(`[process-now] fetchLead erreur (${e.message}) — interestId synthétique ${interestId}`);
    }
  }
  // rawPayload synthétique : si fetchInterest échoue côté Adlead, processPendingLead
  // fait un fallback sur entry.rawPayload.data (c'est exactement le chemin "webhook T0").
  const rawPayload = {
    event: 'interest:created',
    data: {
      id: interestId,
      lead_id: String(leadId),
      program_id: programId ? String(programId) : null,
      status: 'to-process',
      context: {
        lead_id: String(leadId),
        program_id: programId ? String(programId) : null,
      },
    },
  };
  const entry = {
    interestId: String(interestId),
    leadId: String(leadId),
    programId: programId ? String(programId) : null,
    receivedAt: new Date().toISOString(),
    checkAt: new Date().toISOString(),
    rawPayload,
    attempts: 0,
    maxAttempts: 1,
    force,
  };
  const before = processedLeads.length;
  try {
    await processPendingLead(entry);
    const result = processedLeads.slice(before);
    return res.json({ entry, result });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
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

// Dump brut du payload d'un lead — pour investigation : chercher si Adlead
// expose un champ de dénonciation directement sur l'objet lead (denounced,
// registration, active_registration, locked, reported, etc.) qui permettrait
// de sortir du cul-de-sac /registrations 403.
// Dry-run J+15 : liste les candidats qui SERAIENT relancés au prochain tick,
// sans envoyer ni modifier processedLeads. Utile pour valider la règle avant
// d'activer J15_ENABLED=true en prod.
app.get('/api/test/j15-dry-run', async (req, res) => {
  try {
    const result = await j15Tick({ dryRun: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dry-run J+3 matin : liste les candidats qui SERAIENT relancés au prochain
// tick 9h15 Paris, sans envoyer. Utile pour valider la règle avant activation.
app.get('/api/test/j3m-dry-run', async (req, res) => {
  try {
    const result = await j3mTick({ dryRun: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin EMERGENCY : marque tous les records dont programName matche
// /^Programme #\d+$/ comme j15Sent=true. À appeler une fois après l'incident
// 2026-05-15 pour empêcher tout futur tick J+15 de re-spammer ces leads avec
// un sujet "Toujours intéressé par Programme #XXX ?". Idempotent.
app.post('/api/admin/j15-mark-bad-names', (req, res) => {
  const BAD_NAME = /^Programme #\d+$/;
  let marked = 0;
  const at = new Date().toISOString();
  for (const r of processedLeads) {
    if (!r.j15Sent && typeof r.programName === 'string' && BAD_NAME.test(r.programName)) {
      r.j15Sent = true;
      r.j15SentAt = r.j15SentAt || at;
      r.j15Note = 'force-marqué après incident 2026-05-15 (programName non résolu)';
      marked++;
    }
  }
  saveProcessed();
  res.json({ marked, totalProcessed: processedLeads.length, at });
});

// Usage : GET /api/test/lead-dump?programId=611&leadId=1633940
// Renvoie le JSON brut + la liste exhaustive des clés (top-level + nested) +
// le rapport du scanner scanLeadForDenouncedSignals() (champs suspects trouvés).
app.get('/api/test/lead-dump', async (req, res) => {
  const programId = req.query.programId;
  const leadId = req.query.leadId;
  if (!leadId) return res.status(400).json({ error: 'leadId requis' });
  const base = `${CONFIG.ADLEAD_API_BASE}/${CONFIG.ADLEAD_TENANT}`;
  const headers = {
    'X-API-Key': CONFIG.ADLEAD_API_KEY,
    'Accept': 'application/json',
  };
  const urls = [];
  if (programId) urls.push(`${base}/programs/${programId}/leads/${leadId}?include=interests,interests.program,contacts,registrations,activeRegistration,registration`);
  urls.push(`${base}/leads/${leadId}?include=interests,interests.program,contacts,registrations,activeRegistration,registration`);
  urls.push(`${base}/leads/${leadId}`);

  const attempts = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers });
      const t = await r.text();
      let json = null;
      try { json = JSON.parse(t); } catch { /* noop */ }
      const leadObj = json?.data || json || null;
      const topKeys = leadObj && typeof leadObj === 'object' ? Object.keys(leadObj) : [];
      const nestedKeys = {};
      if (leadObj && typeof leadObj === 'object') {
        for (const k of topKeys) {
          const v = leadObj[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            nestedKeys[k] = Object.keys(v);
          } else if (Array.isArray(v) && v[0] && typeof v[0] === 'object') {
            nestedKeys[k] = `[] of {${Object.keys(v[0]).join(',')}} (len=${v.length})`;
          }
        }
      }
      const scan = scanLeadForDenouncedSignals(leadObj, { verbose: true });
      attempts.push({
        url,
        status: r.status,
        ok: r.ok,
        topKeys,
        nestedKeys,
        denouncedScan: scan,
        rawSample: t.slice(0, 8000),
      });
      if (r.ok && json) break; // premier succès, on arrête
    } catch (e) {
      attempts.push({ url, error: e.message });
    }
  }
  res.json({ programId, leadId, attempts });
});

// Scan OBSERVATIONNEL (non bloquant) du payload lead pour détecter un éventuel
// champ de dénonciation directement exposé par Adlead. Retourne la liste des
// champs "suspects" trouvés avec leur valeur. On reste conservateur : on ne
// liste QUE les clés qui ressemblent vraiment à un signal dénonciation, pas
// des champs ambigus (ex: owner/assigned_to qui peuvent légitimement être
// remplis pour un commercial normal).
//
// Utilisation :
//   - Appelé dans /api/test/lead-dump pour investigation manuelle.
//   - Appelé dans le pipeline de relance (non-bloquant) pour LOGUER la
//     présence éventuelle d'un signal — Norman verra apparaître la clé dans
//     les logs Railway et on pourra ensuite commit un vrai check bloquant.
function scanLeadForDenouncedSignals(lead, { verbose = false } = {}) {
  if (!lead || typeof lead !== 'object') return { found: [], checkedKeys: [] };
  // Clés qui, par leur nom même, pointent clairement vers une dénonciation /
  // registration / verrou commercial. Si Adlead en expose une, c'est gagné.
  const suspectKeys = [
    'denounced', 'is_denounced', 'denounced_at', 'denounced_by',
    'reported', 'is_reported', 'reported_at',
    'registration', 'registrations', 'active_registration', 'activeRegistration',
    'registered', 'is_registered', 'registered_at', 'registered_by',
    'flagged', 'is_flagged',
    'locked', 'is_locked', 'locked_by',
    'reservation', 'reservations', 'active_reservation',
  ];
  const found = [];
  for (const key of suspectKeys) {
    if (Object.prototype.hasOwnProperty.call(lead, key)) {
      const v = lead[key];
      // On capture une représentation courte pour le log
      let sample;
      if (v === null || v === undefined) sample = String(v);
      else if (typeof v === 'object') sample = JSON.stringify(v).slice(0, 200);
      else sample = String(v).slice(0, 200);
      found.push({ key, type: typeof v, isArray: Array.isArray(v), sample });
    }
  }
  if (verbose && found.length > 0) {
    console.log(`[denounced-scan] lead ${lead.id || '?'} : signaux potentiels trouvés → ${found.map(f => `${f.key}=${f.sample}`).join(' | ')}`);
  } else if (verbose) {
    console.log(`[denounced-scan] lead ${lead.id || '?'} : aucun des ${suspectKeys.length} champs suspects présent (top keys: ${Object.keys(lead).join(',')})`);
  }
  return { found, checkedKeys: suspectKeys };
}

// Dump brut des registrations d'un programme — utilisé pour vérifier le schéma
// exact (noms de champs) quand le filtre "skip dénoncé" rate un lead.
// Usage : GET /api/test/registrations-dump?programId=611&leadId=1633940
// Retourne la liste complète (page 1) + le(s) registration(s) matchant le lead
// si leadId est fourni.
app.get('/api/test/registrations-dump', async (req, res) => {
  const programId = req.query.programId;
  const leadId = req.query.leadId ? Number(req.query.leadId) : null;
  if (!programId) return res.status(400).json({ error: 'programId requis' });
  const base = `${CONFIG.ADLEAD_API_BASE}/${CONFIG.ADLEAD_TENANT}`;
  try {
    const url = `${base}/programs/${programId}/registrations?page=1&per_page=100`;
    const r = await fetch(url, {
      headers: { 'X-API-Key': CONFIG.ADLEAD_API_KEY, 'Accept': 'application/json' },
    });
    const status = r.status;
    const json = await r.json().catch(() => null);
    const data = Array.isArray(json?.data) ? json.data : [];
    const firstKeys = data[0] ? Object.keys(data[0]) : [];
    const matching = leadId
      ? data.filter(reg => extractLeadIdFromRegistration(reg) === leadId)
      : [];
    res.json({
      url,
      status,
      meta: json?.meta || null,
      count: data.length,
      firstRegistrationKeys: firstKeys,
      firstRegistration: data[0] || null,
      matchingForLead: matching,
      rawResponseSample: JSON.stringify(json).slice(0, 4000),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── REPLY HANDLER — AUTH DEVICE CODE FLOW ──────────────────────────────────
// Flow : Norman ouvre /api/auth/start → le serveur initie le device code, renvoie
// un lien (https://microsoft.com/devicelogin) + un user_code. Norman clique, tape
// le code, approuve. Le serveur poll en arrière-plan jusqu'à obtenir les tokens.
//
// NB: on utilise le public client ID Azure CLI (04b07795-…) qui fonctionne sur
// tous les tenants Microsoft 365 sans app registration ni admin-consent explicite.

app.get('/api/auth/start', async (req, res) => {
  try {
    const r = await inboxWatcher.startDeviceCodeFlow();
    // On renvoie un mini-HTML user-friendly (pour être accessible à la souris depuis Railway)
    if ((req.headers.accept || '').includes('text/html')) {
      return res.send(renderDeviceCodePage(r));
    }
    return res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/status', (req, res) => {
  res.json(inboxWatcher.getDeviceCodeStatus());
});

function renderDeviceCodePage(r) {
  if (r.alreadyInProgress || r.userCode) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auth Microsoft Graph</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;line-height:1.6}code{background:#f4f4f4;padding:4px 8px;border-radius:4px;font-size:1.2em}a.btn{display:inline-block;background:#0078d4;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;margin:12px 0}</style>
</head><body>
<h1>Connexion Microsoft 365 — pilote réponses prospect</h1>
<ol>
  <li>Clique sur le bouton ci-dessous (ça ouvre Microsoft dans un nouvel onglet)</li>
  <li>Tape le code : <code>${r.userCode}</code></li>
  <li>Connecte-toi avec <strong>norman.dadon@catella.com</strong> et approuve</li>
  <li>Reviens ici — c'est fini. Le serveur a les tokens.</li>
</ol>
<p><a class="btn" href="${r.verificationUri}" target="_blank" rel="noopener">Ouvrir Microsoft</a></p>
<p style="color:#888;font-size:14px">Vérifier l'état : <a href="/api/auth/status">/api/auth/status</a></p>
</body></html>`;
  }
  return `<!doctype html><html><body><pre>${JSON.stringify(r, null, 2)}</pre></body></html>`;
}

// ─── REPLY HANDLER — ENDPOINT DE TEST ───────────────────────────────────────
// POST /api/test/reply-handler
// Deux modes :
//   (a) messageId dans le body/query → fetch le message via Graph, run full flow
//       avec dryRun=true (pas de brouillon créé, pas de sales-action Adlead)
//   (b) leadId + subject + body + fromEmail → simulation : classifie + rédige sans
//       Graph (utile pour Norman avant d'avoir approuvé l'auth).
// Le body retourné contient category, reasoning, draft HTML, Adlead action prévue.
app.post('/api/test/reply-handler', async (req, res) => {
  const body = req.body || {};
  const messageId = req.query.messageId || body.messageId;
  const dryRun = String(req.query.dryRun ?? body.dryRun ?? 'true').toLowerCase() !== 'false';

  try {
    // Mode (a) : message existant dans l'inbox Norman, fetch via Graph
    if (messageId) {
      if (!inboxWatcher.hasGraphCreds()) {
        return res.status(400).json({ error: 'Graph non authentifié — lance /api/auth/start d\'abord' });
      }
      // On liste l'inbox des 7 derniers jours et on filtre par id (module n'expose
      // pas un fetch direct, on reste simple pour le pilote).
      const all = await inboxWatcher.listRecentReplies({
        sinceIso: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const msg = all.find(m => m.id === messageId);
      if (!msg) {
        return res.status(404).json({ error: `Message ${messageId} non trouvé dans l'inbox (dernière semaine)` });
      }
      const match = inboxWatcher.matchReplyToRelance(msg);
      const result = await inboxWatcher.handleReply({
        originalMessage: msg,
        relance: match?.relance || null,
        dryRun,
      });
      return res.json({
        mode: 'graph-fetched',
        dryRun,
        messageId,
        matchStrategy: match?.strategy || null,
        matchedRelance: match?.relance || null,
        ...result,
      });
    }

    // Mode (b) : simulation avec input JSON direct (Graph pas requis)
    const { leadId, programId, subject, body: replyBody, fromEmail, fromName, contactName, programName, ville, promoteur, accroche } = body;
    if (!subject && !replyBody) {
      return res.status(400).json({ error: 'subject ou body requis (ou messageId pour fetch depuis Graph)' });
    }
    // Construit le context lead — utilise les relances trackées si leadId fourni
    let relance = null;
    if (leadId) {
      const all = inboxWatcher.getRecentRelances(500);
      relance = all.find(r => String(r.leadId) === String(leadId)) || null;
    }
    const leadContext = {
      leadId: leadId || relance?.leadId || null,
      programId: programId || relance?.programId || null,
      contactEmail: (fromEmail || relance?.contactEmail || '').toLowerCase(),
      contactName: contactName || fromName || relance?.contactName || '',
      programName: programName || relance?.programName || '',
      salutation: contactName || fromName || relance?.contactName || 'Madame, Monsieur',
    };
    const programContext = {
      name: programName || relance?.programName || null,
      ville: ville || null,
      promoteur: promoteur || null,
      accroche: accroche || null,
    };
    const fakeMessage = {
      id: null,
      subject: subject || '',
      body: { contentType: 'text', content: replyBody || '' },
      from: { emailAddress: { address: fromEmail || '' } },
      receivedDateTime: new Date().toISOString(),
      conversationId: null,
    };
    const result = await inboxWatcher.handleReply({
      originalMessage: fakeMessage,
      relance,
      leadContext,
      programContext,
      dryRun: true,  // en simulation, toujours dryRun — on ne crée pas de brouillon ni sales-action
    });
    return res.json({
      mode: 'simulation',
      dryRun: true,
      leadContext,
      programContext,
      ...result,
    });
  } catch (e) {
    console.error('[test/reply-handler] erreur:', e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ─── REPLY HANDLER — TRIGGER MANUEL DU POLL ────────────────────────────────
app.post('/api/reply-handler/poll', async (req, res) => {
  try {
    const r = await inboxWatcher.poll();
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── REPLY HANDLER — DASHBOARD ────────────────────────────────────────────
app.get('/api/dashboard/replies', (req, res) => {
  res.json({
    stats: inboxWatcher.getStats(),
    recentReplies: inboxWatcher.getRecentReplies(50),
    recentRelancesTracked: inboxWatcher.getRecentRelances(50),
  });
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

// ─── REPLY WATCHER — WEBHOOK POWER AUTOMATE ────────────────────────────────
// Reçoit les réponses prospect détectées par un flow Power Automate
// "Lorsqu'un nouveau message arrive (V3)". Permet de contourner la policy
// Conditional Access Catella qui bloque l'auth Graph directe depuis notre
// serveur Railway (IP non-Catella, état device "Unregistered" → AADSTS53003).
//
// Schéma payload attendu (à configurer dans le flow PA) :
// {
//   "from": "client@email.com",
//   "fromName": "Jean Dupont",
//   "subject": "Re: ...",
//   "body": "Contenu du mail (texte ou HTML)",
//   "bodyContentType": "text" | "html",
//   "conversationId": "...",
//   "messageId": "...",
//   "receivedAt": "2026-05-07T10:00:00Z"
// }
//
// Header obligatoire : X-PA-Secret (= POWER_AUTOMATE_INBOX_SECRET côté Railway)
//
// Flow côté serveur :
//   1. Vérifie le secret partagé
//   2. matchReplyToRelance() → retrouve la relance trackée
//   3. classifyReply() → catégorie via Claude Haiku (rdv / info / refus / etc.)
//   4. draftResponse() → brouillon HTML de réponse via Claude Haiku
//   5. Envoie le brouillon à Norman par email (INTERNAL_NOTIF_EMAIL = Gmail perso)
//      → Norman copie-colle dans Outlook pour répondre
//   6. createAdleadReplySalesAction() → action commerciale "Réponse reçue" sur le lead
app.post('/webhook/inbox-reply', async (req, res) => {
  // 1. Auth
  const expected = CONFIG.POWER_AUTOMATE_INBOX_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'POWER_AUTOMATE_INBOX_SECRET non configuré côté serveur' });
  }
  const provided = req.headers['x-pa-secret'] || req.query.secret || '';
  if (provided !== expected) {
    console.warn('[webhook/inbox-reply] secret invalide');
    return res.status(401).json({ error: 'Secret invalide' });
  }

  const p = req.body || {};
  const fromAddr = String(p.from || '').toLowerCase().trim();
  const subject = String(p.subject || '').trim();
  const bodyContent = String(p.body || '').trim();
  const bodyContentType = String(p.bodyContentType || 'text').toLowerCase();
  const conversationId = p.conversationId || null;
  const messageId = p.messageId || null;
  const receivedAt = p.receivedAt || new Date().toISOString();
  const fromName = p.fromName || '';

  if (!fromAddr || (!subject && !bodyContent)) {
    return res.status(400).json({ error: 'Champs from + (subject ou body) requis' });
  }

  // 2. Construit un objet "msg" au format Graph attendu par inboxWatcher.
  const msg = {
    id: messageId,
    subject,
    body: { contentType: bodyContentType === 'html' ? 'html' : 'text', content: bodyContent },
    from: { emailAddress: { address: fromAddr, name: fromName } },
    receivedDateTime: receivedAt,
    conversationId,
  };

  // 3. Match avec une relance trackée. Si rien, on renvoie matched:false → le PA
  //    flow sait qu'il n'y a pas de draft à créer et passe son chemin.
  const match = inboxWatcher.matchReplyToRelance(msg);
  const relance = match?.relance || null;
  const strategy = match?.strategy || null;
  if (!relance) {
    console.log(`[webhook/inbox-reply] aucune relance trackée pour ${fromAddr} (subject: "${subject.slice(0, 60)}") — on ignore`);
    return res.status(200).json({
      matched: false,
      reason: 'Aucune relance trackée correspondant à cette adresse/sujet',
      fromEmail: fromAddr,
      subject,
    });
  }
  console.log(`[webhook/inbox-reply] match ${strategy} → relance lead ${relance.leadId} / ${relance.programName}`);

  // 4. Contexts pour Claude.
  const leadCtx = {
    leadId: relance.leadId,
    programId: relance.programId,
    contactEmail: relance.contactEmail,
    contactName: relance.contactName,
    programName: relance.programName,
    salutation: relance.contactName || 'Madame, Monsieur',
  };
  const programCtx = { name: relance.programName };
  const bodyText = inboxWatcher.extractBodyText(msg);

  // 5. Classification (sync). Fallback "autre" si Claude échoue (crédit 0, timeout).
  let classification;
  try {
    classification = await inboxWatcher.classifyReply({
      subject, body: bodyText, leadContext: leadCtx, programContext: programCtx,
    });
  } catch (e) {
    console.error(`[webhook/inbox-reply] classifyReply échec: ${e.message}`);
    classification = {
      category: 'autre', confidence: 'low',
      reasoning: `classify error: ${e.message}`, extracted: {},
    };
  }

  // 6. Drafting (sync). Fallback stub humble si Claude échoue — on garantit que
  //    PA recevra TOUJOURS un draft HTML utilisable (jamais une 500).
  let draftHtml, internalNote = null;
  try {
    const draft = await inboxWatcher.draftResponse({
      category: classification.category,
      classification,
      replyBody: bodyText,
      replySubject: subject,
      leadContext: leadCtx,
      programContext: programCtx,
    });
    // draftResponse renvoie { shouldDraft, html, internalNote }
    draftHtml = inboxWatcher.wrapWithSignature(draft?.html || '');
    internalNote = draft?.internalNote || null;
  } catch (e) {
    console.error(`[webhook/inbox-reply] draftResponse échec: ${e.message}`);
    draftHtml = inboxWatcher.wrapWithSignature(
      `<p>Bonjour ${leadCtx.contactName || ''},</p>` +
      `<p>Merci pour votre message. Je reviens vers vous très rapidement avec les éléments demandés.</p>` +
      `<p style="color:#888;font-size:12px;">[⚠️ Brouillon auto non disponible : ${e.message} — relire manuellement]</p>`
    );
    internalNote = `⚠️ Drafting Claude a échoué (${e.message}) — relire manuellement avant envoi`;
  }

  // 7. Subject de la réponse — préfixe Re: si manquant.
  let replySubject = subject || '';
  if (replySubject && !/^re\s*:/i.test(replySubject)) {
    replySubject = `Re: ${replySubject}`;
  }

  // 8. Réponse à Power Automate — contient tout ce qu'il faut pour créer le draft
  //    Outlook via l'action "Reply to email (V3)" : conversation préservée, draft
  //    apparaît dans /Brouillons en thread avec le mail original du prospect.
  res.status(200).json({
    matched: true,
    matchStrategy: strategy,
    fromEmail: fromAddr,
    fromName,
    originalMessageId: messageId,
    conversationId,
    leadId: relance.leadId,
    programId: relance.programId,
    programName: relance.programName,
    contactName: relance.contactName,
    classification: {
      category: classification.category,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
      extracted: classification.extracted || {},
    },
    draft: {
      to: fromAddr,
      subject: replySubject,
      html: draftHtml,
      internalNote,
    },
    adleadUrl: buildAdleadLeadUrl(relance.programId, relance.leadId),
  });

  // 9. Async post-response (best-effort, jamais bloquant).
  //    a) Digest mail récap si REPLY_NOTIF_ENABLED — redondance/backup.
  //    b) Sales-action Adlead "Réponse reçue".
  setImmediate(async () => {
    if (CONFIG.REPLY_NOTIF_ENABLED) {
      try {
        const adleadUrl = buildAdleadLeadUrl(relance.programId, relance.leadId);
        const notifSubject = `📥 Réponse client — ${relance.programName || 'Programme'} — ${relance.contactName || fromAddr} (${classification.category})`;
        const notifHtml = `
<!doctype html><html lang="fr"><body style="font-family: Arial, sans-serif; font-size: 14px; color: #222; line-height: 1.55;">
<p>Bonjour Norman,</p>
<p>Le prospect <strong>${relance.contactName || fromAddr}</strong> a répondu à ta relance auto sur <strong>${relance.programName || 'le programme'}</strong>.</p>
<ul style="list-style: none; padding-left: 0;">
  <li>• <strong>Catégorie</strong> : ${classification.category} ${classification.confidence ? `(confiance ${classification.confidence})` : ''}</li>
  <li>• <strong>Raisonnement IA</strong> : ${classification.reasoning || '—'}</li>
  ${internalNote ? `<li>• <strong>Note interne</strong> : ${internalNote}</li>` : ''}
  <li>• <strong>Lien Adlead</strong> : <a href="${adleadUrl}">${adleadUrl}</a></li>
</ul>
<h3 style="margin-top: 24px;">Le mail du client :</h3>
<blockquote style="border-left: 3px solid #ccc; padding-left: 12px; color: #555;">
  ${(bodyText || '(corps vide)').replace(/\n/g, '<br>')}
</blockquote>
<h3 style="margin-top: 24px;">Brouillon de réponse (normalement déjà dans /Brouillons via Power Automate) :</h3>
<div style="border: 1px solid #ddd; padding: 16px; border-radius: 8px; background: #fafafa;">
  ${draftHtml}
</div>
<p style="color: #888; font-size: 12px; margin-top: 24px;">— Reply Watcher Catella · Power Automate trigger</p>
</body></html>`;
        await sendEmailViaPowerAutomate(CONFIG.INTERNAL_NOTIF_EMAIL, notifSubject, notifHtml);
        console.log(`[webhook/inbox-reply] ✅ digest envoyé à ${CONFIG.INTERNAL_NOTIF_EMAIL}`);
      } catch (e) {
        console.error(`[webhook/inbox-reply] ⚠️ digest échec: ${e.message}`);
      }
    }
    try {
      await inboxWatcher.createAdleadReplySalesAction({
        programId: relance.programId,
        leadId: relance.leadId,
        category: classification.category,
        reasoning: classification.reasoning || '',
      });
      console.log(`[webhook/inbox-reply] ✅ sales-action Adlead créée sur lead ${relance.leadId}`);
    } catch (e) {
      console.error(`[webhook/inbox-reply] ⚠️ sales-action Adlead échec: ${e.message}`);
    }
  });
});

// ─── HELPER : validation signature Twilio ───────────────────────────────────
// Doc : https://www.twilio.com/docs/usage/webhooks/webhooks-security
// Signature = base64(HMAC-SHA1(authToken, fullUrl + sorted(key+value...)))
// fullUrl doit être l'URL EXACTE configurée côté Twilio (scheme + host + path + query).
// Sur Railway le serveur est derrière un reverse-proxy → utiliser x-forwarded-* pour
// reconstruire l'URL telle que vue par Twilio.
function validateTwilioSignature(req, fullUrl) {
  const signature = req.headers['x-twilio-signature'] || '';
  if (!signature) return false;
  if (!CONFIG.TWILIO_AUTH_TOKEN) return false;
  const params = req.body || {};
  const keys = Object.keys(params).sort();
  let data = fullUrl;
  for (const k of keys) data += k + (params[k] == null ? '' : String(params[k]));
  const expected = crypto.createHmac('sha1', CONFIG.TWILIO_AUTH_TOKEN)
                          .update(Buffer.from(data, 'utf-8'))
                          .digest('base64');
  if (signature.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── WEBHOOK : Twilio "WhatsApp incoming" (réponses prospect) ───────────────
// Configuré côté Twilio : WhatsApp Senders > +13853324609 > Edit > "Webhook URL for
// incoming messages" → https://lead-automation-production-33e8.up.railway.app/webhook/whatsapp-incoming
// Méthode : HTTP POST. Twilio envoie form-urlencoded (From, To, Body, ProfileName, MessageSid…).
// Sécurité : signature HMAC SHA1 validée via x-twilio-signature (TWILIO_VALIDATE_SIGNATURE=false
// pour bypass en dev/debug seulement).
app.post('/webhook/whatsapp-incoming', express.urlencoded({ extended: false }), async (req, res) => {
  // 1. Validation signature Twilio
  const proto   = req.headers['x-forwarded-proto'] || 'https';
  const host    = req.headers['x-forwarded-host'] || req.headers.host;
  const fullUrl = `${proto}://${host}${req.originalUrl}`;
  if (CONFIG.TWILIO_VALIDATE_SIGNATURE) {
    if (!validateTwilioSignature(req, fullUrl)) {
      console.warn(`[webhook/whatsapp-incoming] signature Twilio invalide (url=${fullUrl}) — refusé`);
      return res.status(403).type('text/xml').send('<Response/>');
    }
  } else {
    console.warn('[webhook/whatsapp-incoming] (info) validation signature désactivée — debug uniquement');
  }

  // 2. ACK immédiat (twiml vide = pas de réponse auto au prospect)
  res.status(200).type('text/xml').send('<Response/>');

  // 3. Extract des champs Twilio (form-urlencoded)
  const p           = req.body || {};
  const fromRaw     = String(p.From || '');           // "whatsapp:+33612345678"
  const toRaw       = String(p.To   || '');           // "whatsapp:+13853324609"
  const body        = String(p.Body || '').trim();
  const msgSid      = p.MessageSid || p.SmsMessageSid || null;
  const profileName = p.ProfileName || '';
  const fromE164    = fromRaw.replace(/^whatsapp:/, '').trim();

  if (!fromE164 || !body) {
    console.log('[webhook/whatsapp-incoming] payload incomplet — ignoré', { fromE164, hasBody: !!body, msgSid });
    return;
  }
  console.log(`[webhook/whatsapp-incoming] reçu de ${fromE164} (profile: "${profileName}", sid: ${msgSid}): "${body.slice(0, 100)}"`);

  // 4. Traitement asynchrone non bloquant (best-effort)
  setImmediate(async () => {
    try {
      // Match : cherche le lead "sent" le plus récent avec whatsappTo == fromE164.
      // Normalise les 2 côtés (E164 strict, virer espaces/non-digits) pour matcher
      // même si l'enregistrement contient des variantes de formatage.
      const normalizeForMatch = (s) => String(s || '').replace(/[^\d+]/g, '');
      const fromNorm = normalizeForMatch(fromE164);
      let match = null;
      for (let i = processedLeads.length - 1; i >= 0; i--) {
        const l = processedLeads[i];
        if (l.status !== 'sent') continue;
        if (!l.whatsappTo) continue;
        if (normalizeForMatch(l.whatsappTo) === fromNorm) {
          match = l;
          break;
        }
      }

      // 5a. Ping email + WhatsApp à Norman (même si pas matché — on lui passe quand même
      //     le message en mode "numéro inconnu" pour qu'il puisse identifier manuellement).
      const adleadUrl = match ? buildAdleadLeadUrl(match.programId, match.leadId) : null;
      const contactDisplay = match ? (match.contactName || profileName || fromE164)
                                   : (profileName || fromE164);
      const programDisplay = match ? (match.programName || `programme #${match.programId}`)
                                   : '— (lead inconnu)';
      const notifSubject = match
        ? `📱 RÉPONSE WhatsApp — ${contactDisplay} — ${programDisplay}`
        : `📱 WhatsApp ${profileName ? `de ${profileName}` : `inconnu`} (${fromE164}) — lead non identifié`;
      const matchSection = match ? `
<ul style="list-style: none; padding-left: 0;">
  <li>• <strong>Prospect</strong> : ${match.contactName || profileName || '(non renseigné)'}</li>
  <li>• <strong>Numéro WhatsApp</strong> : ${fromE164}${profileName ? ` (profil : ${profileName})` : ''}</li>
  <li>• <strong>Programme</strong> : ${match.programName || '—'} (id ${match.programId})</li>
  <li>• <strong>Lien Adlead</strong> : <a href="${adleadUrl}">${adleadUrl}</a></li>
</ul>` : `
<p>⚠️ <strong>Aucun lead trouvé avec ce numéro</strong> (${fromE164}). Soit la relance auto n'a jamais été envoyée à ce numéro, soit le formatage du téléphone diffère côté Adlead vs WhatsApp.</p>
<ul style="list-style: none; padding-left: 0;">
  <li>• <strong>Numéro WhatsApp</strong> : ${fromE164}</li>
  <li>• <strong>Profil WhatsApp</strong> : ${profileName || '—'}</li>
</ul>`;
      const notifHtml = `
<!doctype html><html lang="fr"><body style="font-family: Arial, sans-serif; font-size: 14px; color: #222; line-height: 1.55;">
<p>Bonjour Norman,</p>
<p>Un prospect ${match ? `(<strong>${contactDisplay}</strong>) ` : ''}vient de répondre par <strong>WhatsApp</strong> à une relance auto sur <strong>${programDisplay}</strong>.</p>
${matchSection}
<h3 style="margin-top: 24px;">Message du client :</h3>
<blockquote style="border-left: 3px solid #25D366; padding: 10px 12px; color: #222; background: #f6fff8; border-radius: 4px;">
  ${body.replace(/\n/g, '<br>')}
</blockquote>
${match ? `<p style="margin-top: 24px; padding: 12px; background: #fff8dc; border-left: 4px solid #f0c000; border-radius: 4px;">
  ⚠️ <strong>Pense à poser une action côté Adlead</strong> pour bloquer le lead (sinon un autre commercial peut le récupérer).
</p>` : ''}
<p style="color: #888; font-size: 12px; margin-top: 24px;">— Reply Watcher WhatsApp · Twilio incoming (sid: ${msgSid || 'n/a'})</p>
</body></html>`;

      try {
        await sendEmailViaPowerAutomate(CONFIG.INTERNAL_NOTIF_EMAIL, notifSubject, notifHtml);
        console.log(`[webhook/whatsapp-incoming] ✅ mail récap envoyé à ${CONFIG.INTERNAL_NOTIF_EMAIL}`);
      } catch (e) {
        console.error(`[webhook/whatsapp-incoming] ⚠️ mail récap échec: ${e.message}`);
      }

      // 5b. WhatsApp à Norman (notif urgente courte sur son téléphone)
      if (CONFIG.WHATSAPP_ENABLED && CONFIG.INTERNAL_NOTIF_PHONE) {
        try {
          const waBody = match
            ? `📱 RÉPONSE WhatsApp PROSPECT — ACTION ADLEAD URGENTE\n\n• Prospect : ${contactDisplay}\n• Programme : ${match.programName || '—'}\n• Numéro : ${fromE164}\n\nMessage :\n"${body.slice(0, 250)}${body.length > 250 ? '…' : ''}"\n\n→ Adlead : ${adleadUrl}`
            : `📱 WhatsApp inconnu ${profileName ? `(${profileName})` : ''} — ${fromE164}\n\nMessage :\n"${body.slice(0, 250)}${body.length > 250 ? '…' : ''}"\n\n(pas matché à un lead — voir mail)`;
          const resp = await sendWhatsAppViaTwilio(CONFIG.INTERNAL_NOTIF_PHONE, waBody);
          console.log(`[webhook/whatsapp-incoming] ✅ WhatsApp Norman envoyé (sid: ${resp.sid})`);
        } catch (e) {
          console.error(`[webhook/whatsapp-incoming] ⚠️ WhatsApp Norman échec: ${e.message}`);
        }
      }

      // 5c. Notif Telegram à Norman (canal urgent supplémentaire — indépendant du WhatsApp
      //     interne qui ne marchera plus en prod Meta sans template approuvé).
      if (CONFIG.TELEGRAM_NOTIF_ENABLED && CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
        try {
          const tgText = match ? (
            `📱 <b>RÉPONSE WhatsApp prospect — ACTION ADLEAD URGENTE</b>\n\n` +
            `• <b>Prospect</b> : ${escapeTelegramHtml(contactDisplay)}\n` +
            `• <b>Programme</b> : ${escapeTelegramHtml(match.programName || '—')}\n` +
            `• <b>Numéro</b> : <code>${escapeTelegramHtml(fromE164)}</code>${profileName ? ` <i>(${escapeTelegramHtml(profileName)})</i>` : ''}\n\n` +
            `<blockquote>${escapeTelegramHtml(body.slice(0, 800))}${body.length > 800 ? '…' : ''}</blockquote>\n\n` +
            `→ <a href="${adleadUrl}">Ouvrir dans Adlead</a>\n\n` +
            `<i>⚠️ Pose une action Adlead immédiatement (autre vendeur peut prendre le lead).</i>`
          ) : (
            `📱 <b>WhatsApp inconnu</b> — lead non identifié\n\n` +
            `• <b>Numéro</b> : <code>${escapeTelegramHtml(fromE164)}</code>${profileName ? ` <i>(${escapeTelegramHtml(profileName)})</i>` : ''}\n\n` +
            `<blockquote>${escapeTelegramHtml(body.slice(0, 800))}${body.length > 800 ? '…' : ''}</blockquote>\n\n` +
            `<i>Aucun lead "sent" trouvé pour ce numéro. Voir mail pour détails.</i>`
          );
          const resp = await sendTelegramNotification(tgText);
          console.log(`[webhook/whatsapp-incoming] ✅ Telegram envoyé (message_id: ${resp?.result?.message_id || 'n/a'})`);
        } catch (e) {
          console.error(`[webhook/whatsapp-incoming] ⚠️ Telegram échec: ${e.message}`);
        }
      }

      // 6. Sales-action Adlead "Réponse WhatsApp reçue" (seulement si lead matché)
      if (match) {
        try {
          await inboxWatcher.createAdleadReplySalesAction({
            programId: match.programId,
            leadId: match.leadId,
            category: 'whatsapp_reply',
            reasoning: `Réponse WhatsApp du prospect : ${body.slice(0, 200)}`,
          });
          console.log(`[webhook/whatsapp-incoming] ✅ sales-action Adlead créée sur lead ${match.leadId}`);
        } catch (e) {
          console.error(`[webhook/whatsapp-incoming] ⚠️ sales-action Adlead échec: ${e.message}`);
        }
      }

      // 7. Trace dans processedLeads pour audit dashboard
      processedLeads.push({
        id: `wa-reply-${msgSid || Date.now()}`,
        status: 'whatsapp_reply_received',
        leadId: match ? match.leadId : null,
        programId: match ? match.programId : null,
        programName: match ? match.programName : null,
        contactName: match ? match.contactName : null,
        whatsappFrom: fromE164,
        whatsappBody: body,
        whatsappMessageSid: msgSid,
        whatsappProfileName: profileName,
        relatedSentId: match ? match.id : null,
        matched: !!match,
        receivedAt: new Date().toISOString(),
        processedAt: new Date().toISOString(),
      });
      saveProcessed();
    } catch (err) {
      console.error('[webhook/whatsapp-incoming] erreur traitement:', err.message, err.stack);
    }
  });
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

// ─── RELANCE J+15 ────────────────────────────────────────────────────────────
// Cron quotidien à J15_CRON_HOUR_PARIS (heure Europe/Paris) qui scanne
// processedLeads pour les leads où :
//   - age (depuis receivedAt) >= J15_DELAY_DAYS jours
//   - statut Adlead actuel = "pending" ("En attente de contact")
//   - last_interaction_at est null OU < (now - J15_DELAY_DAYS jours)
//   - aucune relance J+15 déjà envoyée (idempotence via record.j15Sent)
// Pour chaque candidat → envoie email J+15 + WhatsApp J+15 (gated).

const J15_ELIGIBLE_STATUSES = new Set(['sent', 'cancelled', 'skipped', 'error']);

function isJ15Candidate(record, now) {
  if (record.j15Sent) return false;
  if (!J15_ELIGIBLE_STATUSES.has(record.status)) return false;
  if (!record.leadId || !record.programId) return false;
  if (EXCLUDED_PROGRAM_SET.has(String(record.programId))) return false;
  const refMs = new Date(record.receivedAt || record.processedAt || 0).getTime();
  if (!refMs) return false;
  const ageDays = (now - refMs) / (1000 * 60 * 60 * 24);
  return ageDays >= CONFIG.J15_DELAY_DAYS;
}

function buildJ15Email(firstName, programName) {
  const subject = `Toujours intéressé(e) par ${programName} ?`;
  const html = `<p>Bonjour ${firstName},</p>
<p>Je reviens vers vous concernant votre demande sur ${programName}, déposée il y a quelques semaines.</p>
<p>Sans nouvelles, je voulais m'assurer que votre projet immobilier est toujours d'actualité. Depuis votre première demande quelques lots se sont libérés et il reste des opportunités intéressantes selon votre budget et votre recherche.</p>
<p>N'hésitez pas à me répondre directement à ce mail avec vos critères d'acquisition, je pourrai vous envoyer les plans et les prix.</p>
<p>Souhaitez-vous qu'on prenne 10 minutes au téléphone cette semaine ? Vous pouvez réserver un créneau directement ici :<br/>
<a href="${CONFIG.BOOKING_URL}">${CONFIG.BOOKING_URL}</a></p>
<p>Au plaisir d'échanger,<br/>
Norman DADON<br/>
—<br/>
Catella Residential — Logement neuf</p>`;
  return { subject, html };
}

async function processJ15Candidate(record, { dryRun = false, sendDisabled = false } = {}) {
  const lead = await fetchLead(record.leadId, { programId: record.programId });
  if (!lead) return { skipped: true, reason: 'lead introuvable côté Adlead' };
  if (lead.is_under_prescription === true) return { skipped: true, reason: 'is_under_prescription=true' };
  if (lead.status !== 'pending')           return { skipped: true, reason: `lead.status="${lead.status}" (≠ pending)` };

  const now = Date.now();
  const cutoff = now - CONFIG.J15_DELAY_DAYS * 24 * 60 * 60 * 1000;
  if (lead.last_interaction_at) {
    const liMs = new Date(lead.last_interaction_at).getTime();
    if (liMs > cutoff) return { skipped: true, reason: `last_interaction_at trop récent (${lead.last_interaction_at})` };
  }

  const contact = (lead.contacts && lead.contacts[0]) || null;
  if (!contact) return { skipped: true, reason: 'aucun contact sur le lead' };
  const email = contact.email || record.email;
  if (!email) return { skipped: true, reason: "pas d'email sur le contact" };
  if (contact.has_opted_out === true || contact.opted_out_at) return { skipped: true, reason: 'contact opt-out' };

  const firstName = contact.firstname || (contact.fullname || record.contactName || '').split(' ')[0] || 'bonjour';

  // Résolution robuste du programName : on REJETTE le fallback "Programme #XXX"
  // qui peut traîner dans record.programName (posé en J+1 quand l'API Adlead
  // n'avait pas renvoyé le nom du programme). On retente via fetchProgram pour
  // avoir un vrai nom — et si toujours rien, on SKIP plutôt que d'envoyer un
  // mail au sujet "Toujours intéressé par Programme #611 ?" (très peu pro).
  const BAD_NAME = /^Programme #\d+$/;
  let programName = record.programName;
  if (!programName || BAD_NAME.test(programName)) {
    programName = lead.program?.name || lead.program?.nom_commercial || null;
  }
  if (!programName || BAD_NAME.test(programName)) {
    try {
      const prog = await fetchProgram(record.programId);
      programName = prog?.name || prog?.nom_commercial || null;
    } catch (_) {}
  }
  if (!programName || BAD_NAME.test(programName)) {
    return { skipped: true, reason: `programme non résolu (programId=${record.programId})` };
  }

  const { subject, html } = buildJ15Email(firstName, programName);

  // GATE CRITIQUE — en mode dry-run OU si kill switch sends actif, on retourne
  // le verdict sans appeler sendEmail/sendWhatsApp. C'est la SEULE manière
  // correcte de prouver qu'un dry-run n'envoie rien. Voir incident 2026-05-15.
  if (dryRun || sendDisabled) {
    return {
      sent: true,           // would-have-sent
      email, subject,
      dryRun: !!dryRun,
      sendDisabled: !!sendDisabled,
    };
  }

  let emailError = null, whatsappSid = null, whatsappError = null, whatsappTo = null;
  try {
    await sendEmailViaPowerAutomate(email, subject, html);
  } catch (e) {
    emailError = e.message;
  }

  if (CONFIG.WHATSAPP_J15_ENABLED && CONFIG.TWILIO_TEMPLATE_RELANCE_J15) {
    const phone = contact.phone || record.whatsappTo;
    whatsappTo = normalizePhoneE164(phone);
    if (whatsappTo) {
      try {
        const r = await sendWhatsAppViaTwilio(whatsappTo, '', {
          templateSid: CONFIG.TWILIO_TEMPLATE_RELANCE_J15,
          contentVariables: { '1': firstName, '2': programName },
        });
        whatsappSid = r?.sid || null;
      } catch (e) {
        whatsappError = e.message;
      }
    }
  }

  return { sent: true, email, subject, emailError, whatsappTo, whatsappSid, whatsappError };
}

// Throttle pour respecter le rate limit Adlead (60 req/min).
const j15Sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Wrapper avec retry sur 429 Too Many Requests Adlead. Le message Adlead contient
// "réessayer dans X secondes" → on parse X et on attend X+2s avant retry.
async function processJ15CandidateWithRetry(record, { dryRun = false, sendDisabled = false, maxRetries = 3 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await processJ15Candidate(record, { dryRun, sendDisabled });
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('429 Too Many Requests') && attempt < maxRetries) {
        // Le message Adlead arrive en JSON avec é (unicode escape), donc
        // on matche sur "dans X seconde" plutôt que sur "réessayer".
        const m = msg.match(/dans (\d+) seconde/);
        const waitS = m ? Number(m[1]) + 2 : 30;
        console.log(`[j15] 429 sur lead ${record.leadId}, attente ${waitS}s (tentative ${attempt + 1}/${maxRetries})`);
        await j15Sleep(waitS * 1000);
        continue;
      }
      throw e;
    }
  }
}

let j15TickRunning = false;
async function j15Tick({ dryRun = false } = {}) {
  if (j15TickRunning) return { skipped: 'tick déjà en cours' };
  if (!dryRun && !CONFIG.J15_ENABLED) return { skipped: 'J15_ENABLED=false' };
  j15TickRunning = true;
  try {
    const now = Date.now();
    const candidates = processedLeads.filter(r => isJ15Candidate(r, now));
    console.log(`[j15] ${candidates.length} candidat(s) à examiner (dryRun=${dryRun})`);
    const results = [];
    for (let i = 0; i < candidates.length; i++) {
      // Throttle 1.1s entre chaque candidat → ≤55 req/min, sous le rate limit Adlead.
      if (i > 0) await j15Sleep(1100);
      const record = candidates[i];
      try {
        const result = await processJ15CandidateWithRetry(record, {
          dryRun,
          sendDisabled: CONFIG.J15_SEND_DISABLED,
        });
        results.push({ leadId: record.leadId, programId: record.programId, programName: record.programName, ...result });
        if (result.sent && !dryRun) {
          record.j15Sent = true;
          record.j15SentAt = new Date().toISOString();
          record.j15Email = result.email;
          record.j15Subject = result.subject;
          record.j15EmailError = result.emailError;
          record.j15WhatsappTo = result.whatsappTo;
          record.j15WhatsappSid = result.whatsappSid;
          record.j15WhatsappError = result.whatsappError;
          // CRITIQUE : save APRÈS CHAQUE envoi pour ne pas perdre l'idempotence
          // si le tick crashe ou est killé en plein vol. Sinon les leads déjà
          // touchés seront re-spammés au tick suivant. Voir incident 2026-05-15.
          saveProcessed();
        }
      } catch (e) {
        console.error(`[j15] lead ${record.leadId} erreur:`, e.message);
        results.push({ leadId: record.leadId, programId: record.programId, error: e.message });
      }
    }
    if (!dryRun) {
      saveProcessed();
      const sentCount = results.filter(r => r.sent).length;
      const skipCount = results.filter(r => r.skipped).length;
      const errCount  = results.filter(r => r.error || r.emailError || r.whatsappError).length;
      if (sentCount + errCount > 0) {
        try {
          await sendTelegramNotification(
            `📤 <b>Tick J+15</b>\nCandidats: ${candidates.length}\nEnvoyés: ${sentCount}\nSkip: ${skipCount}\nErreurs: ${errCount}`
          );
        } catch (_) {}
      }
    }
    return { dryRun, candidates: candidates.length, results };
  } finally {
    j15TickRunning = false;
  }
}

let lastJ15RunYmd = null;
function getParisYmdAndHour() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}
async function j15Cron() {
  const { ymd, hour } = getParisYmdAndHour();
  if (hour !== CONFIG.J15_CRON_HOUR_PARIS) return;
  if (lastJ15RunYmd === ymd) return;
  lastJ15RunYmd = ymd;
  try { await j15Tick(); }
  catch (e) { console.error('[j15-cron] erreur:', e.message); }
}
setInterval(j15Cron, 5 * 60 * 1000);
j15Cron().catch(e => console.error('[j15-cron] check initial:', e.message));

// ─── RELANCE J+3 MATIN (3 messages d'escalation post-pending) ────────────────
// Cron quotidien à 9h15 Paris qui relance les leads dont le statut Adlead est
// "pending" depuis ≥24h. 3 jours consécutifs avec escalation E/W/E :
//   Jour 1 : email "doux"
//   Jour 2 : WhatsApp "moyen" (fallback email si template Meta pas dispo)
//   Jour 3 : email "final"
// Stop dès que lead.status ≠ "pending" → reset pendingSince + j3mRelances.
// Idempotence : si j3mRelances >= 3 le lead n'est plus candidat.

function getParisYmdHourMinute() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function isJ3MCandidate(record, now) {
  if (!record.leadId || !record.programId) return false;
  if (EXCLUDED_PROGRAM_SET.has(String(record.programId))) return false;
  if ((record.j3mRelances || 0) >= 3) return false;
  const refMs = new Date(record.receivedAt || record.processedAt || 0).getTime();
  if (!refMs) return false;
  const ageDays = (now - refMs) / (1000 * 60 * 60 * 24);
  if (ageDays > 60) return false; // trop vieux, on laisse J+15 ou abandon
  return true;
}

function buildJ3MEmailDay1(firstName, programName) {
  const subject = `Petit point sur votre demande ${programName}`;
  const html = `<p>Bonjour ${firstName},</p>
<p>Petit point rapide concernant votre demande pour ${programName}. Je n'ai pas encore eu votre retour suite à mes premiers messages, et je préférais m'assurer que vous les avez bien reçus.</p>
<p>Avez-vous quelques minutes pour qu'on échange brièvement de votre projet ? Vous pouvez réserver un créneau directement ici :<br/>
<a href="${CONFIG.BOOKING_URL}">${CONFIG.BOOKING_URL}</a></p>
<p>Au plaisir d'échanger,<br/>
Norman DADON<br/>
—<br/>
Catella Residential — Logement neuf</p>`;
  return { subject, html };
}

function buildJ3MEmailDay2Fallback(firstName, programName) {
  // Fallback email pour le jour 2 quand le template WhatsApp Meta n'est pas
  // disponible. Reprend le wording WhatsApp validé par Norman.
  const subject = `${programName} — disponibilités à étudier`;
  const html = `<p>Bonjour ${firstName},</p>
<p>Je reviens vers vous concernant votre demande sur ${programName}.</p>
<p>Je viens de regarder le programme : nous avons encore des disponibilités. Si votre projet est toujours d'actualité, c'est le moment d'en discuter. N'hésitez pas à me donner vos critères d'acquisition.</p>
<p>Ou discutons : avez-vous 10 minutes cette semaine ? Réservation directe ici :<br/>
<a href="${CONFIG.BOOKING_URL}">${CONFIG.BOOKING_URL}</a></p>
<p>Norman DADON<br/>
—<br/>
Catella Residential — Logement neuf</p>`;
  return { subject, html };
}

function buildJ3MEmailDay3(firstName, programName) {
  const subject = `${programName} — dernier point avant de classer votre dossier`;
  const html = `<p>Bonjour ${firstName},</p>
<p>Dernier message de ma part concernant ${programName}.</p>
<p>Sans nouvelles, je vais classer votre dossier en fin de semaine. Si votre projet immobilier est toujours d'actualité, c'est vraiment le moment de me le faire savoir.</p>
<ul>
<li>Réservez un créneau ici pour qu'on échange : <a href="${CONFIG.BOOKING_URL}">${CONFIG.BOOKING_URL}</a></li>
<li>Ou répondez directement à ce mail avec vos critères, je vous envoie immédiatement les plans et les prix disponibles.</li>
</ul>
<p>Je reste à votre disposition,<br/>
Norman DADON<br/>
—<br/>
Catella Residential — Logement neuf</p>`;
  return { subject, html };
}

async function processJ3MCandidate(record, { dryRun = false, sendDisabled = false } = {}) {
  const lead = await fetchLead(record.leadId, { programId: record.programId });
  if (!lead) return { skipped: true, reason: 'lead introuvable côté Adlead' };

  // Safety : dénonciation bloque toujours (consistant avec J+1 et J+15).
  if (lead.is_under_prescription === true) {
    return { skipped: true, reason: 'is_under_prescription=true' };
  }

  // Status check — règle Option A : si status ≠ pending, on reset et on stop.
  if (lead.status !== 'pending') {
    let reset = false;
    if (record.pendingSince || (record.j3mRelances || 0) > 0) {
      if (!dryRun) {
        record.pendingSince = null;
        record.j3mRelances = 0;
      }
      reset = true;
    }
    return { skipped: true, reason: `lead.status="${lead.status}" (≠ pending)`, reset };
  }

  // Première détection du status pending → on note pendingSince, on n'envoie pas.
  if (!record.pendingSince) {
    const nowIso = new Date().toISOString();
    if (!dryRun) record.pendingSince = nowIso;
    return {
      skipped: true,
      reason: 'pendingSince noté, première détection — 24h d\'attente avant relance',
      pendingSinceSet: nowIso,
    };
  }

  // 24h wait depuis pendingSince.
  const pendingMs = new Date(record.pendingSince).getTime();
  const ageHours = (Date.now() - pendingMs) / (1000 * 60 * 60);
  if (ageHours < 24) {
    return { skipped: true, reason: `pending depuis seulement ${ageHours.toFixed(1)}h, attente 24h min` };
  }

  // Max 3 relances.
  const currentCount = record.j3mRelances || 0;
  if (currentCount >= 3) {
    return { skipped: true, reason: 'max 3 relances atteintes' };
  }
  const dayNumber = currentCount + 1; // 1, 2, ou 3

  // Contact + email check.
  const contact = (lead.contacts && lead.contacts[0]) || null;
  if (!contact) return { skipped: true, reason: 'aucun contact sur le lead' };
  const email = contact.email || record.email;
  if (!email) return { skipped: true, reason: "pas d'email sur le contact" };
  if (contact.has_opted_out === true || contact.opted_out_at) return { skipped: true, reason: 'contact opt-out' };

  // Résolution robuste programName (refus bad-name fallback, cf J+15).
  const BAD_NAME = /^Programme #\d+$/;
  let programName = record.programName;
  if (!programName || BAD_NAME.test(programName)) {
    programName = lead.program?.name || lead.program?.nom_commercial || null;
  }
  if (!programName || BAD_NAME.test(programName)) {
    try { const prog = await fetchProgram(record.programId); programName = prog?.name || prog?.nom_commercial || null; }
    catch (_) {}
  }
  if (!programName || BAD_NAME.test(programName)) {
    return { skipped: true, reason: `programme non résolu (programId=${record.programId})` };
  }

  const firstName = contact.firstname || (contact.fullname || record.contactName || '').split(' ')[0] || 'bonjour';

  // Determine channel + content pour ce jour.
  let channel, subject = null, html = null, whatsappTo = null;
  if (dayNumber === 1) {
    channel = 'email';
    ({ subject, html } = buildJ3MEmailDay1(firstName, programName));
  } else if (dayNumber === 2) {
    if (CONFIG.WHATSAPP_J3M_ENABLED && CONFIG.TWILIO_TEMPLATE_J3M_DAY2) {
      channel = 'whatsapp';
      whatsappTo = normalizePhoneE164(contact.phone || record.whatsappTo);
    } else {
      // Fallback email pour ne pas casser le cycle d'escalation.
      channel = 'email-fallback';
      ({ subject, html } = buildJ3MEmailDay2Fallback(firstName, programName));
    }
  } else { // dayNumber === 3
    channel = 'email';
    ({ subject, html } = buildJ3MEmailDay3(firstName, programName));
  }

  // GATE CRITIQUE (cf incident 2026-05-15) — en dry-run ou sendDisabled,
  // on retourne le verdict sans appeler sendEmail/sendWhatsApp.
  if (dryRun || sendDisabled) {
    return {
      sent: true,
      dayNumber, channel, email, subject, whatsappTo,
      dryRun: !!dryRun, sendDisabled: !!sendDisabled,
    };
  }

  // Envoi réel.
  let emailError = null, whatsappSid = null, whatsappError = null;
  if (channel === 'email' || channel === 'email-fallback') {
    try {
      await sendEmailViaPowerAutomate(email, subject, html);
    } catch (e) { emailError = e.message; }
  } else if (channel === 'whatsapp') {
    if (whatsappTo) {
      try {
        const r = await sendWhatsAppViaTwilio(whatsappTo, '', {
          templateSid: CONFIG.TWILIO_TEMPLATE_J3M_DAY2,
          contentVariables: { '1': firstName, '2': programName },
        });
        whatsappSid = r?.sid || null;
      } catch (e) { whatsappError = e.message; }
    } else {
      whatsappError = 'no valid phone';
    }
  }

  return {
    sent: true,
    dayNumber, channel, email, subject, whatsappTo,
    emailError, whatsappSid, whatsappError,
  };
}

async function processJ3MCandidateWithRetry(record, { dryRun = false, sendDisabled = false, maxRetries = 3 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await processJ3MCandidate(record, { dryRun, sendDisabled });
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('429 Too Many Requests') && attempt < maxRetries) {
        const m = msg.match(/dans (\d+) seconde/);
        const waitS = m ? Number(m[1]) + 2 : 30;
        console.log(`[j3m] 429 sur lead ${record.leadId}, attente ${waitS}s (tentative ${attempt + 1}/${maxRetries})`);
        await j15Sleep(waitS * 1000);
        continue;
      }
      throw e;
    }
  }
}

let j3mTickRunning = false;
async function j3mTick({ dryRun = false } = {}) {
  if (j3mTickRunning) return { skipped: 'tick déjà en cours' };
  if (!dryRun && !CONFIG.J3M_ENABLED) return { skipped: 'J3M_ENABLED=false' };
  j3mTickRunning = true;
  try {
    const now = Date.now();
    const candidates = processedLeads.filter(r => isJ3MCandidate(r, now));
    console.log(`[j3m] ${candidates.length} candidat(s) à examiner (dryRun=${dryRun})`);
    const results = [];
    let stateChangedNoSend = false;
    for (let i = 0; i < candidates.length; i++) {
      if (i > 0) await j15Sleep(1100); // réutilise le throttle Adlead
      const record = candidates[i];
      try {
        const result = await processJ3MCandidateWithRetry(record, {
          dryRun,
          sendDisabled: CONFIG.J3M_SEND_DISABLED,
        });
        results.push({ leadId: record.leadId, programId: record.programId, programName: record.programName, ...result });
        if (!dryRun) {
          // Sauvegarde immédiate après chaque envoi (cf incident 2026-05-15).
          if (result.sent) {
            record.j3mRelances = (record.j3mRelances || 0) + 1;
            record.j3mHistory = record.j3mHistory || [];
            record.j3mHistory.push({
              day: result.dayNumber,
              channel: result.channel,
              sentAt: new Date().toISOString(),
              emailError: result.emailError || null,
              whatsappSid: result.whatsappSid || null,
              whatsappError: result.whatsappError || null,
            });
            saveProcessed();
          } else if (result.reset || result.pendingSinceSet) {
            // État muté (pendingSince posé ou reset) → flag pour save final.
            stateChangedNoSend = true;
          }
        }
      } catch (e) {
        console.error(`[j3m] lead ${record.leadId} erreur:`, e.message);
        results.push({ leadId: record.leadId, programId: record.programId, error: e.message });
      }
    }
    if (!dryRun) {
      if (stateChangedNoSend) saveProcessed();
      const sentCount = results.filter(r => r.sent).length;
      const skipCount = results.filter(r => r.skipped).length;
      const errCount  = results.filter(r => r.error || r.emailError || r.whatsappError).length;
      if (sentCount + errCount > 0) {
        try {
          await sendTelegramNotification(
            `📤 <b>Tick J+3 matin</b>\nCandidats: ${candidates.length}\nEnvoyés: ${sentCount}\nSkip: ${skipCount}\nErreurs: ${errCount}`
          );
        } catch (_) {}
      }
    }
    return { dryRun, candidates: candidates.length, results };
  } finally {
    j3mTickRunning = false;
  }
}

let lastJ3MRunYmd = null;
async function j3mCron() {
  const { ymd, hour, minute } = getParisYmdHourMinute();
  if (hour !== CONFIG.J3M_CRON_HOUR_PARIS) return;
  if (minute < CONFIG.J3M_CRON_MIN_MINUTE) return;
  if (lastJ3MRunYmd === ymd) return;
  lastJ3MRunYmd = ymd;
  try { await j3mTick(); }
  catch (e) { console.error('[j3m-cron] erreur:', e.message); }
}
setInterval(j3mCron, 5 * 60 * 1000);
j3mCron().catch(e => console.error('[j3m-cron] check initial:', e.message));

// ─── SCHEDULER INBOX (réponses prospect) ────────────────────────────────────
// Poll séparé pour ne pas ralentir le scheduler principal. Kill-switch via
// REPLY_HANDLER_ENABLED=false — si inactif, le tick ne fait rien (même pas
// d'appel Graph).
let inboxTickRunning = false;
async function inboxSchedulerTick() {
  if (inboxTickRunning) return;
  if (!CONFIG.REPLY_HANDLER_ENABLED) return;
  if (!CONFIG.ANTHROPIC_API_KEY)     return;
  if (!inboxWatcher.hasGraphCreds()) return;
  inboxTickRunning = true;
  try {
    const r = await inboxWatcher.poll();
    if (r && r.matched > 0) {
      console.log(`[inbox-scheduler] ${r.matched}/${r.polled} message(s) traité(s)`);
    }
  } catch (e) {
    console.error('[inbox-scheduler] erreur:', e.message);
  } finally {
    inboxTickRunning = false;
  }
}
setInterval(inboxSchedulerTick, CONFIG.REPLY_POLL_INTERVAL_MS);
// Pas de tick initial — on attend que Norman ait fait l'auth.
