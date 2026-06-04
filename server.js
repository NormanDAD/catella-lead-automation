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
  // Format: "Nom Agent:YYYY-MM-DD,Nom Agent2:YYYY-MM-DD"
  // Leads dont le tracker correspond seront skippés jusqu'à la date indiquée.
  PAUSED_AGENTS: String(process.env.PAUSED_AGENTS || '')
                   .split(',')
                   .map(s => s.trim())
                   .filter(Boolean)
                   .map(entry => {
                     const idx = entry.lastIndexOf(':');
                     if (idx === -1) return { name: entry, until: null };
                     return { name: entry.slice(0, idx).trim(), until: entry.slice(idx + 1).trim() };
                   }),
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
  // Date (ISO YYYY-MM-DD) à partir de laquelle les WhatsApp sont en prod Meta réelle.
  // Les envois antérieurs (sandbox non-délivrés) sont exclus des stats WhatsApp.
  WHATSAPP_PROD_START_DATE: process.env.WHATSAPP_PROD_START_DATE || '',
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
  // WhatsApp J+15 gated via WHATSAPP_J15_ENABLED + TWILIO_TEMPLATE_J16 (template jour 2 = J+16).
  J15_ENABLED:           process.env.J15_ENABLED === 'true',
  J15_DELAY_DAYS:        Number(process.env.J15_DELAY_DAYS || 15),
  J15_CRON_HOUR_PARIS:   Number(process.env.J15_CRON_HOUR_PARIS || 10),
  WHATSAPP_J15_ENABLED:  process.env.WHATSAPP_J15_ENABLED === 'true',
  // Kill switch BELT-AND-SUSPENDERS pour les envois J+15 : si true, AUCUN
  // sendEmail / sendWhatsApp ne peut partir depuis le code path J+15, même
  // si J15_ENABLED=true et même en mode "réel" (pas dry-run). À utiliser
  // pour valider le code en prod sans risque d'envoi indu. Ajouté après
  // l'incident 2026-05-15 (mon /api/test/j15-dry-run envoyait pour de vrai).
  J15_SEND_DISABLED:     process.env.J15_SEND_DISABLED === 'true',
  // ── Kill switch J+1 auto-send ────────────────────────────────────────────
  // Si true, processPendingLead tourne normalement (fetch, checks, dénonciation)
  // mais SKIP les envois mail/WhatsApp/notif/tag/status. Le record est finalisé
  // avec status="j1-manual-pending" → Norman traite manuellement. Les règles 2/3
  // retrouvent le lead via scan processedLeads. Activé en prod depuis 2026-05-18
  // (Norman a repris la main sur le J+1).
  J1_AUTO_SEND_DISABLED: process.env.J1_AUTO_SEND_DISABLED === 'true',
  // ContentSid Twilio du template Meta "relance_j16_catella" (jour 2 de règle 3)
  TWILIO_TEMPLATE_J16:   process.env.TWILIO_TEMPLATE_J16 || '',
  // ── Fenêtre horaire d'envoi ──────────────────────────────────────────────
  // Règle Norman : aucun envoi à un prospect en dehors de 9h-20h Paris,
  // et aucun envoi le dimanche (toute la journée). Voir isWithinAllowedSendHours().
  SEND_HOUR_START_PARIS: Number(process.env.SEND_HOUR_START_PARIS || 9),   // 9h inclus
  SEND_HOUR_END_PARIS:   Number(process.env.SEND_HOUR_END_PARIS   || 20),  // 20h exclu
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
  // Slack Incoming Webhook URL pour le rapport quotidien de santé du pipeline.
  // Créer via api.slack.com/apps → "Incoming Webhooks" → Add New Webhook → choisir le canal.
  // Format : https://hooks.slack.com/services/T.../B.../...
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || '',
  // URL de base publique du serveur, utilisée pour reconstruire l'URL exacte lors de la
  // validation de signature Twilio. Railway ne transmet pas x-forwarded-host de façon fiable,
  // ce qui faisait échouer la validation (URL reconstituée ≠ URL signée par Twilio).
  // Valeur prod : https://lead-automation-production-33e8.up.railway.app
  TWILIO_WEBHOOK_BASE_URL: process.env.TWILIO_WEBHOOK_BASE_URL || 'https://lead-automation-production-33e8.up.railway.app',
  // URL de callback Twilio pour le suivi de livraison WhatsApp (delivery tracking).
  // Twilio POST sur cette URL à chaque changement de statut : queued → sent → delivered → read → failed.
  // Si vide, aucun StatusCallback n'est envoyé à l'envoi. Valeur prod :
  // https://lead-automation-production-33e8.up.railway.app/webhook/twilio-status
  TWILIO_STATUS_CALLBACK_URL: process.env.TWILIO_STATUS_CALLBACK_URL || '',
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
  ADMIN_UPLOAD_TOKEN:    process.env.ADMIN_UPLOAD_TOKEN || '',
  // Mot de passe dashboard. Si vide → pas d'auth (rétrocompat dev local).
  DASHBOARD_PASSWORD:    process.env.DASHBOARD_PASSWORD || '',
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
const BROCHURES_DIR = path.join(DATA_DIR, 'brochures');
const PENDING_FILE = path.join(DATA_DIR, 'pending_leads.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed_leads.json');
const PROGRAM_NAME_CACHE_FILE = path.join(DATA_DIR, 'program_name_cache.json');

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

let _diskAlertSent = false;
function checkDiskSpace() {
  try {
    const stat = fs.statfsSync(DATA_DIR);
    const freeMb = (stat.bfree * stat.bsize) / (1024 * 1024);
    if (freeMb < 80 && !_diskAlertSent) {
      _diskAlertSent = true;
      const msg = `⚠️ ALERTE ESPACE DISQUE : volume Railway à ${freeMb.toFixed(0)} MB libres — risque ENOSPC imminent. Purger les brochures ou agrandir le volume.`;
      console.error('[persistence]', msg);
    } else if (freeMb >= 80) {
      _diskAlertSent = false;
    }
  } catch (_) {}
}

function saveJsonFile(file, data) {
  checkDiskSpace();
  try {
    ensureDataDir();
    // Écriture atomique : write→tmp puis rename pour éviter la corruption si kill en pleine écriture
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
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

// ─── BROCHURES ───────────────────────────────────────────────────────────────
// brochures.json : { "Nom Programme": "slug.pdf" } — généré par scripts/build-brochures.js
// Fichiers servis depuis BROCHURES_DIR (= DATA_DIR/brochures) uploadés via /api/admin/upload-brochure.
let BROCHURES = {};
try { BROCHURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'brochures.json'), 'utf8')); } catch (_) {}

function _normBrochureKey(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
const BROCHURES_NORM = Object.fromEntries(Object.entries(BROCHURES).map(([k, v]) => [_normBrochureKey(k), v]));

function getBrochureUrl(programName) {
  if (!programName) return null;
  const slug = BROCHURES[programName] || BROCHURES_NORM[_normBrochureKey(programName)];
  if (!slug) return null;
  const base = (CONFIG.TWILIO_WEBHOOK_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/brochures/${slug}` : null;
}

let pendingLeads = loadJsonFile(PENDING_FILE, []);
let processedLeads = loadJsonFile(PROCESSED_FILE, []);

// Cache global programId → nom propre. Persisté sur disque
// (PROGRAM_NAME_CACHE_FILE) pour survivre aux redéploiements Railway.
// Sources de peuplement :
//   1. loadProgramNameCacheFromDisk() au boot (fichier persisté)
//   2. prefetchProgramNameCacheFromProcessed() au boot (fallback depuis processedLeads)
//   3. processPendingLead() au runtime (chaque lead traité avec nom résolu)
//   4. endpoint admin /api/admin/resolve-program-names (lookup Adlead à la demande)
// Utilisé par /api/pending et /api/leads pour ne plus afficher "Programme #XXX"
// dans le dashboard.
const programNameCache = new Map();
const BAD_PROGRAM_NAME = /^Programme #\d+$/;
function saveProgramNameCache() {
  saveJsonFile(PROGRAM_NAME_CACHE_FILE, Object.fromEntries(programNameCache));
}
function loadProgramNameCacheFromDisk() {
  const obj = loadJsonFile(PROGRAM_NAME_CACHE_FILE, {});
  let loaded = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k && v && !BAD_PROGRAM_NAME.test(v)) {
      programNameCache.set(String(k), v);
      loaded++;
    }
  }
  console.log(`[programNameCache] ${loaded} entrées chargées depuis ${PROGRAM_NAME_CACHE_FILE}`);
}
function prefetchProgramNameCacheFromProcessed() {
  let added = 0;
  for (const r of processedLeads) {
    if (r.programId && r.programName && !BAD_PROGRAM_NAME.test(r.programName)) {
      const key = String(r.programId);
      if (!programNameCache.has(key)) {
        programNameCache.set(key, r.programName);
        added++;
      }
    }
  }
  console.log(`[programNameCache] ${added} programmes ajoutés au cache depuis processedLeads (${processedLeads.length} records scannés)`);
  if (added > 0) saveProgramNameCache();
}
loadProgramNameCacheFromDisk();
prefetchProgramNameCacheFromProcessed();

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

// Middleware admin : tous les endpoints /api/admin/* et /api/test/* et /api/scheduler/* requièrent
// soit x-admin-token (curl/API), soit une session dashboard valide (navigateur connecté).
function requireAdmin(req, res, next) {
  if (isDashboardAuthenticated(req)) return next();
  const token = req.headers['x-admin-token'] || req.query._token || '';
  if (!CONFIG.ADMIN_UPLOAD_TOKEN) return res.status(503).json({ error: 'ADMIN_UPLOAD_TOKEN non configuré' });
  if (token !== CONFIG.ADMIN_UPLOAD_TOKEN) return res.status(401).json({ error: 'Token admin requis' });
  next();
}
app.use('/api/admin', requireAdmin);
app.use('/api/test', requireAdmin);
app.use('/api/scheduler', requireAdmin);
app.use('/api/reply-handler', requireAdmin);

// ── AUTHENTIFICATION DASHBOARD ────────────────────────────────────────────────
// Cookie signé HMAC-SHA256. Session valide 30 jours (renouvelée à chaque visite).
// Routes toujours publiques : /webhook/*, /api/health, /login, /logout.
// Si DASHBOARD_PASSWORD est vide (dev local) → auth désactivée.

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('=').trim());
  }
  return cookies;
}

function dashboardSessionToken() {
  const secret = CONFIG.ADMIN_UPLOAD_TOKEN || 'dev-secret';
  return require('crypto').createHmac('sha256', secret).update('dash-v1').digest('hex');
}

function isDashboardAuthenticated(req) {
  if (!CONFIG.DASHBOARD_PASSWORD) return true;
  const cookies = parseCookies(req);
  return cookies.dash_session === dashboardSessionToken();
}

function setDashboardCookie(res) {
  const token = dashboardSessionToken();
  const maxAge = 30 * 24 * 60 * 60; // 30 jours
  res.setHeader('Set-Cookie', `dash_session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`);
}

function clearDashboardCookie(res) {
  res.setHeader('Set-Cookie', 'dash_session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/');
}

// Middleware global — protège tout sauf webhooks, health, login, logout.
app.use((req, res, next) => {
  const PUBLIC = ['/webhook/', '/api/health', '/login', '/logout', '/brochures/'];
  if (PUBLIC.some(p => req.path.startsWith(p))) return next();
  if (isDashboardAuthenticated(req)) {
    setDashboardCookie(res); // renouvelle la session à chaque visite
    return next();
  }
  // Requêtes admin avec x-admin-token → laisse passer (requireAdmin vérifiera le token ensuite)
  const adminToken = req.headers['x-admin-token'] || req.query._token || '';
  if (adminToken && CONFIG.ADMIN_UPLOAD_TOKEN && adminToken === CONFIG.ADMIN_UPLOAD_TOKEN) {
    return next();
  }
  // API calls → 401 JSON. Navigation → redirect login.
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// ─── BROCHURES — service des PDFs depuis le volume Railway ──────────────────
app.get('/brochures/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.endsWith('.pdf')) return res.status(400).end();
  const filePath = path.join(BROCHURES_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
});

// GET /api/admin/raw-file?f=processed_leads.json — lit un fichier data brut (récupération urgence)
app.get('/api/admin/raw-file', (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  if (!CONFIG.ADMIN_UPLOAD_TOKEN || token !== CONFIG.ADMIN_UPLOAD_TOKEN) return res.status(401).end();
  const allowed = ['processed_leads.json', 'pending_leads.json'];
  const name = req.query.f || '';
  if (!allowed.includes(name)) return res.status(400).end();
  const filePath = path.join(DATA_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

// DELETE /api/admin/brochures — vide BROCHURES_DIR pour libérer de l'espace
app.delete('/api/admin/brochures', (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  if (!CONFIG.ADMIN_UPLOAD_TOKEN || token !== CONFIG.ADMIN_UPLOAD_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const files = fs.existsSync(BROCHURES_DIR) ? fs.readdirSync(BROCHURES_DIR) : [];
    for (const f of files) fs.unlinkSync(path.join(BROCHURES_DIR, f));
    res.json({ ok: true, deleted: files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/disk-usage — taille des fichiers data + espace libre volume
app.get('/api/admin/disk-usage', (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  if (!CONFIG.ADMIN_UPLOAD_TOKEN || token !== CONFIG.ADMIN_UPLOAD_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const stat = fs.statfsSync(DATA_DIR);
    const freeMb  = (stat.bfree  * stat.bsize) / (1024 * 1024);
    const totalMb = (stat.blocks * stat.bsize) / (1024 * 1024);
    const files = ['pending_leads.json', 'processed_leads.json', 'program_name_cache.json', 'graph_token_cache.json'].map(f => {
      const fp = path.join(DATA_DIR, f);
      const size = fs.existsSync(fp) ? fs.statSync(fp).size : 0;
      return { file: f, sizeMb: +(size / (1024 * 1024)).toFixed(2) };
    });
    let brochuresMb = 0;
    if (fs.existsSync(BROCHURES_DIR)) {
      for (const f of fs.readdirSync(BROCHURES_DIR)) {
        try { brochuresMb += fs.statSync(path.join(BROCHURES_DIR, f)).size; } catch (_) {}
      }
      brochuresMb = +(brochuresMb / (1024 * 1024)).toFixed(2);
    }
    res.json({ freeMb: +freeMb.toFixed(1), totalMb: +totalMb.toFixed(1), files, brochuresMb });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/trim-processed?keep=N — conserve les N dernières entrées de processed_leads.json
app.post('/api/admin/trim-processed', (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  if (!CONFIG.ADMIN_UPLOAD_TOKEN || token !== CONFIG.ADMIN_UPLOAD_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const keep = Math.max(100, parseInt(req.query.keep || '500', 10));
  const before = processedLeads.length;
  if (before <= keep) return res.json({ ok: true, before, after: before, removed: 0 });
  processedLeads.splice(0, before - keep);
  saveProcessed();
  res.json({ ok: true, before, after: processedLeads.length, removed: before - processedLeads.length });
});

// GET /api/admin/brochures/status — liste les brochures de brochures.json avec présence sur disque
app.get('/api/admin/brochures/status', (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  if (!CONFIG.ADMIN_UPLOAD_TOKEN || token !== CONFIG.ADMIN_UPLOAD_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const result = Object.entries(BROCHURES).map(([name, slug]) => ({
    name,
    slug,
    present: fs.existsSync(path.join(BROCHURES_DIR, slug)),
  }));
  res.json(result);
});

// POST /api/admin/upload-brochure?filename=slug.pdf
// Corps : application/octet-stream (le PDF brut). Auth : x-admin-token.
app.post('/api/admin/upload-brochure', (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  if (!CONFIG.ADMIN_UPLOAD_TOKEN || token !== CONFIG.ADMIN_UPLOAD_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const filename = path.basename(req.query.filename || '');
  if (!filename || !filename.endsWith('.pdf')) {
    return res.status(400).json({ error: 'filename must end in .pdf' });
  }
  fs.mkdirSync(BROCHURES_DIR, { recursive: true });
  const ws = fs.createWriteStream(path.join(BROCHURES_DIR, filename));
  let bytes = 0;
  req.on('data', chunk => { bytes += chunk.length; });
  req.pipe(ws);
  ws.on('finish', () => res.json({ ok: true, filename, bytes }));
  ws.on('error', e => res.status(500).json({ error: e.message }));
});

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

// Met à jour le statut d'un lead Adlead via PUT /interest.
// Statuts valides : to-process, pending, to-follow, ongoing, interested, negotiating,
//                   discarded, pending-purchaser, purchaser
// Route confirmée par Cédric Morrier (Adlead) le 2026-06-02 :
//   PUT /v1/{tenantKey}/programs/{programId}/leads/{leadId}/interest
// Requiert le scope lead.update sur la clé API.
async function updateLeadStatusAdlead(programId, leadId, statusKey) {
  if (!CONFIG.STATUS_UPDATE_ENABLED) {
    return { skipped: true, reason: 'STATUS_UPDATE_ENABLED=false' };
  }
  const url = `${CONFIG.ADLEAD_API_BASE}/${CONFIG.ADLEAD_TENANT}/programs/${programId}/leads/${leadId}/interest`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-API-Key': CONFIG.ADLEAD_API_KEY,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: statusKey }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Adlead PUT /interest ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => ({}));
  return json.data || json;
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

// Crée un compte rendu d'événement sur un lead dans Adlead.
// Requiert le scope record.create sur la clé API.
// event : voir enum complet dans docs.adlead.immo/v1/records.html
// Non bloquant — toujours appeler dans un try/catch.
async function createAdleadRecord(programId, leadId, event, comment) {
  // occurred_at en heure Paris (Adlead affiche sans conversion timezone)
  const now = new Date();
  const parisStr = now.toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).replace(' ', 'T');
  return adleadPost(`/programs/${programId}/leads/${leadId}/records`, {
    event,
    comment: comment || null,
    occurred_at: parisStr,
  });
}

// Notification interne à Norman : après l'envoi auto du mail client, on lui envoie
// un mail "à la main" avec le lien Adlead du lead à traiter manuellement.
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
  if (CONFIG.SKIP_REGISTRATIONS_CHECK) return null;
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
  const parsed = splitName(contact.fullname || contact.display_name || '');
  const lastname = contact.name || parsed.lastname || '';
  const firstname = contact.firstname || parsed.firstname || '';
  const rawTitle = (contact.title_display || contact.title || '').trim().toLowerCase();
  let title = '';
  if (['mr', 'm', 'm.', 'monsieur'].includes(rawTitle)) title = 'Monsieur';
  else if (['ms', 'mme', 'mme.', 'madame', 'mrs', 'miss'].includes(rawTitle)) title = 'Madame';
  else if (rawTitle) title = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1);
  if (title && lastname) return `${title} ${lastname}`;
  if (title && firstname) return `${title} ${firstname}`;
  if (title) return title;
  return 'Madame, Monsieur';
}

// ─── TEMPLATE EMAIL CATELLA ─────────────────────────────────────────────────

function buildEmailSubject(ctx) {
  return `Votre projet à ${ctx.ville} — quelques précisions sur « ${ctx.programme} »`;
}

function stripAccrochePrefix(accroche, ville, promoteur) {
  if (!accroche) return '';
  let s = accroche.trim();
  // Retire "À [ville], " en début de phrase (ville déjà mentionnée dans l'email)
  s = s.replace(/^À\s+[^,]+,\s*/, '');
  // Retire " par [promoteur]" (promoteur déjà mentionné)
  if (promoteur) {
    const re = new RegExp('\\s+par\\s+' + promoteur.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
    s = s.replace(re, '');
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildEmailBody(ctx) {
  const accrocheText = stripAccrochePrefix(ctx.accroche_programme, ctx.ville, ctx.promoteur);
  const accrochePhrase = accrocheText ? ` <em>${escapeHtml(accrocheText)}</em>` : '';

  return `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222;">
<p>Bonjour ${escapeHtml(ctx.salutation)},</p>

<p>Merci pour l'intérêt que vous portez à notre programme <strong>&laquo;&nbsp;${escapeHtml(ctx.programme)}&nbsp;&raquo;</strong> à ${escapeHtml(ctx.ville)}, proposé par ${escapeHtml(ctx.promoteur)}.${accrochePhrase}</p>
${brochureButton(ctx.brochureUrl)}
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

function extractNameFromBodies(messages) {
  for (const m of messages) {
    const hit = (m.body || '').match(/Bonjour\s+([A-ZÀ-Ÿa-zà-ÿ][a-zà-ÿ\-]+)[,\n]/);
    if (hit) return hit[1].charAt(0).toUpperCase() + hit[1].slice(1);
  }
  return null;
}

function extractProgramFromBodies(messages) {
  for (const m of messages) {
    const m1 = (m.body || '').match(/programme\s+([A-ZÀÉÈÊËÎÏÔÙÛÜ0-9][^\n,.]{2,40})/i);
    if (m1) return m1[1].trim().replace(/\.$/, '');
  }
  return null;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function brochureButton(url) {
  if (!url) return '';
  return `<p style="margin:20px 0 16px;">
  <a href="${url}" style="display:inline-block;background:#1a3a5c;color:#fff;padding:10px 22px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:600;">📄 Télécharger la brochure du programme</a>
</p>`;
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
  if (CONFIG.TWILIO_STATUS_CALLBACK_URL) {
    params.append('StatusCallback', CONFIG.TWILIO_STATUS_CALLBACK_URL);
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
      ...(entry.manualSource ? { manualOverride: true } : {}),
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

    // L'endpoint programme ne retourne pas last_interaction_at (doc Adlead v1).
    // L'endpoint tenant le retourne → on l'enrichit si absent pour fiabiliser
    // la détection d'activité commerciale (check timestamps J+1).
    if (!lead.last_interaction_at) {
      try {
        const tenantLead = await adleadGet(`/leads/${entry.leadId}`);
        if (tenantLead?.last_interaction_at) {
          lead.last_interaction_at = tenantLead.last_interaction_at;
          console.log(`[process] lead ${entry.leadId} — last_interaction_at enrichi depuis endpoint tenant : ${tenantLead.last_interaction_at}`);
        }
      } catch (_e) { /* non bloquant */ }
    }

    // Log exhaustif pour diagnostiquer quels champs Adlead met à jour lors d'actions commerciales
    const _diagLead = {
      status: lead?.status,
      last_interaction_at: lead?.last_interaction_at,
      updated_at: lead?.updated_at,
      last_event_at: lead?.last_event_at,
      last_activity_at: lead?.last_activity_at,
      contacted_at: lead?.contacted_at,
      assigned_at: lead?.assigned_at,
      events_count: Array.isArray(lead?.events) ? lead.events.length : lead?.events_count ?? 'n/a',
      activities_count: Array.isArray(lead?.activities) ? lead.activities.length : 'n/a',
    };
    console.log(`[diag] lead ${entry.leadId} timestamps+status:`, JSON.stringify(_diagLead));
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
    const _diagInterest = {
      status: interest?.status,
      last_interaction_at: interest?.last_interaction_at,
      updated_at: interest?.updated_at,
      last_event_at: interest?.last_event_at,
      contacted_at: interest?.contacted_at,
      source: interestSource,
    };
    console.log(`[diag] interest ${entry.interestId}:`, JSON.stringify(_diagInterest));

    // ── CHECK AGENT EN PAUSE (PAUSED_AGENTS) ─────────────────────────────────
    const trackerName = (obj) => {
      if (!obj) return '';
      if (typeof obj === 'string') return obj.toLowerCase();
      return (obj.fullname || obj.full_name || obj.name || obj.display_name || obj.email || '').toLowerCase();
    };
    if (CONFIG.PAUSED_AGENTS.length > 0) {
      const t1 = trackerName(interest.first_tracker);
      const t2 = trackerName(interest.last_tracker);
      const today = new Date().toISOString().slice(0, 10);
      for (const pa of CONFIG.PAUSED_AGENTS) {
        const agentLower = pa.name.toLowerCase();
        if ((t1.includes(agentLower) || t2.includes(agentLower)) && (!pa.until || today <= pa.until)) {
          console.log(`[process] lead ${entry.leadId} — agent "${pa.name}" en pause jusqu'au ${pa.until || '∞'} → skip`);
          return finalize({
            id: entry.interestId,
            status: 'skipped',
            reason: `Agent "${pa.name}" en période d'adaptation (pause jusqu'au ${pa.until || '∞'})`,
            contactName: lead.contacts?.[0]?.fullname || '',
            email: lead.contacts?.[0]?.email_primary || '',
            programId: entry.programId,
            programName: interest.program?.name || '',
          });
        }
      }
    }

    // ── CHECK DÉNONCIATION — priorité absolue avant tout autre check ──────────
    // is_under_prescription=true = prescripteur revendique le lead → denounced.
    // S'applique même si entry.force=true : règle métier non contournable.
    if (lead.is_under_prescription === true) {
      console.log(`[process] lead ${entry.leadId} sous prescription → denounced`);
      return finalize({
        id: entry.interestId,
        status: 'denounced',
        reason: 'Lead sous prescription (is_under_prescription=true)',
        contactName: lead.contacts?.[0]?.fullname || '',
        email: lead.contacts?.[0]?.email_primary || '',
        programId: entry.programId,
        programName: interest.program?.name || '',
        leadStatus: lead.status || null,
        isUnderPrescription: true,
      });
    }

    // ── DÉTECTION "commercial a pris la main" ────────────────────────────────
    // Règle : "pending" (affecté mais non traité) n'est PAS bloquant. Seuls
    // les statuts indiquant un traitement actif bloquent l'envoi J+1.
    // Pour last_interaction_at, on ne bloque que si le lead est déjà en statut
    // actif (sinon, une simple affectation → pending ferait sonner l'alarme).
    // entry.force bypass ce check (utilisé par /api/test/process-now).
    const COMMERCIAL_ACTED_STATUSES = new Set([
      'ongoing', 'to-follow', 'interested', 'negotiating',
      'discarded', 'pending-purchaser', 'purchaser',
    ]);
    let commercialActed = false;
    let reason = '';
    if (entry.force) {
      console.log(`[process] entry.force=true → on bypass le check commercialActed`);
    } else if (interestSource !== 'rawPayload (webhook T0)' && interest.status && COMMERCIAL_ACTED_STATUSES.has(interest.status)) {
      commercialActed = true;
      reason = `Statut interest = "${interest.status}"`;
    } else if (entry.receivedAt) {
      const rc = new Date(entry.receivedAt).getTime();
      // Vérifie last_interaction_at au niveau du lead ET de l'interest
      // (Adlead met parfois à jour l'un sans l'autre selon le type d'action)
      const timestamps = [
        lead.last_interaction_at,
        lead.updated_at,
        interest.last_interaction_at,
        interest.updated_at,
      ];
      for (const ts of timestamps) {
        if (!ts) continue;
        const li = new Date(ts).getTime();
        if (li > rc + 60_000) {
          commercialActed = true;
          reason = `Activité détectée (${ts}) postérieure à receivedAt (${entry.receivedAt})`;
          break;
        }
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

    // ── CHECK STATUT LEAD & DISCARD ──────────────────────────────────────────
    // Bloque si le statut lead indique un traitement actif (même ensemble que ci-dessus).
    // "pending" et "to-process" ne bloquent pas.
    let leadBlocked = false;
    let blockReason = '';
    const blockStatusKey = 'cancelled';
    if (COMMERCIAL_ACTED_STATUSES.has(lead.status)) {
      leadBlocked = true;
      blockReason = `Lead statut Adlead = "${lead.status}" (traitement actif détecté)`;
    } else if (lead.discard_reason) {
      leadBlocked = true;
      blockReason = `Lead discardé (discard_reason=${lead.discard_reason})`;
    }
    if (leadBlocked) {
      console.log(`[process] lead ${entry.leadId} BLOQUÉ : ${blockReason} → on n'envoie pas`);
      return finalize({
        id: entry.interestId,
        status: blockStatusKey,
        reason: blockReason,
        contactName: lead.contacts?.[0]?.fullname || '',
        email: lead.contacts?.[0]?.email_primary || '',
        programId: entry.programId,
        programName: interest.program?.name || '',
        leadStatus: lead.status || null,
        isUnderPrescription: false,
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
    if (entry.programId && !BAD_PROGRAM_NAME.test(programName)) {
      const _k = String(entry.programId);
      if (programNameCache.get(_k) !== programName) {
        programNameCache.set(_k, programName);
        saveProgramNameCache();
      }
    }

    // ─── GATE J1_AUTO_SEND_DISABLED ─────────────────────────────────────────
    // Si activé, on a fait tous les checks (lead valide, contact OK, pas dénoncé,
    // commercial n'a pas agi) mais on NE déclenche AUCUN envoi auto-J+1. Le record
    // passe en "j1-manual-pending" → Norman traite manuellement (envoi mail+WhatsApp
    // + pose actions Adlead). Les règles 2 et 3 retrouvent ce lead via scan
    // processedLeads pour relancer aux jours J+3/+4/+5 puis J+15/+16/+17.
    if (CONFIG.J1_AUTO_SEND_DISABLED) {
      console.log(`[process] J1_AUTO_SEND_DISABLED=true → skip auto-send lead ${entry.leadId} (Norman traite manuellement)`);
      return finalize({
        id: entry.interestId,
        status: 'j1-manual-pending',
        contactName: contact.fullname || '',
        email,
        programId: entry.programId,
        programName,
        note: 'Auto-send désactivé via J1_AUTO_SEND_DISABLED — à traiter manuellement (mail + WhatsApp + actions Adlead)',
      });
    }

    // Gate fenêtre horaire (règle Norman 2026-05-18) — pas d'envoi prospect
    // hors 9h-20h Paris ni le dimanche. On NE finalize PAS : le lead reste
    // en queue avec un checkAt repoussé à la prochaine fenêtre valide.
    if (!isWithinAllowedSendHours()) {
      const next = computeNextAllowedSendTime();
      console.log(`[process] hors fenêtre 9h-20h Paris (ou dimanche) → report lead ${entry.leadId} jusqu'à ${next.toISOString()}`);
      entry.checkAt = next.toISOString();
      savePending();
      return; // ne pas finalize, reste en queue
    }

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
      brochureUrl: getBrochureUrl(programName),
    };

    const subject = buildEmailSubject(ctx);
    const htmlBody = buildEmailBody(ctx);

    await sendEmailViaPowerAutomate(email, subject, htmlBody);
    console.log(`[process] ✅ email envoyé à ${email} — "${subject}" (accroche: ${accroche ? 'oui' : 'non'})`);

    // ── Compte rendu Adlead — email J+1
    try {
      await createAdleadRecord(entry.programId, entry.leadId, 'email', 'Email envoyé');
      console.log(`[process] ✅ record Adlead créé (email J+1) lead ${entry.leadId}`);
    } catch (e) {
      console.log(`[process] (info) record Adlead échec lead ${entry.leadId}: ${e.message.slice(0, 120)}`);
    }

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
          const _j1BrochureUrl = getBrochureUrl(programName);
          const sendOptions = CONFIG.TWILIO_TEMPLATE_RELANCE_J1 ? {
            templateSid: CONFIG.TWILIO_TEMPLATE_RELANCE_J1,
            contentVariables: {
              "1": firstname || 'bonjour',
              "2": programName || 'votre projet',
              ...(_j1BrochureUrl ? { "3": _j1BrochureUrl } : {}),
            },
          } : {};
          const resp = await sendWhatsAppViaTwilio(phoneE164, body, sendOptions);
          whatsappSid = resp && resp.sid ? resp.sid : null;
          const mode = CONFIG.TWILIO_TEMPLATE_RELANCE_J1 ? 'template' : 'body';
          console.log(`[process] ✅ WhatsApp envoyé à ${phoneE164} (mode: ${mode}, sid: ${whatsappSid})`);
          try {
            await createAdleadRecord(entry.programId, entry.leadId, 'sms', 'WhatsApp envoyé');
            console.log(`[process] ✅ record Adlead créé (WhatsApp J+1) lead ${entry.leadId}`);
          } catch (re) {
            console.log(`[process] (info) record Adlead WA échec lead ${entry.leadId}: ${re.message.slice(0, 120)}`);
          }
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

// GET /login — formulaire de connexion
app.get('/login', (req, res) => {
  if (isDashboardAuthenticated(req)) return res.redirect('/');
  const next = req.query.next || '/';
  const error = req.query.err ? '<p style="color:#c0392b;margin:0 0 16px;font-size:14px;">Mot de passe incorrect.</p>' : '';
  res.type('html').send(`<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Catella — Connexion</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .card{background:white;border-radius:16px;padding:40px;width:100%;max-width:360px;box-shadow:0 4px 24px rgba(0,0,0,.08);}
  .logo{font-size:22px;font-weight:700;color:#1a3a5c;margin-bottom:8px;}
  .sub{font-size:13px;color:#6e6e73;margin-bottom:28px;}
  label{display:block;font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:6px;}
  input[type=password]{width:100%;padding:12px 14px;border:1px solid #d1d1d6;border-radius:8px;font-size:15px;outline:none;transition:border .15s;}
  input[type=password]:focus{border-color:#1a3a5c;}
  button{width:100%;margin-top:20px;padding:13px;background:#1a3a5c;color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;}
  button:hover{background:#152f4a;}
</style></head><body>
<div class="card">
  <div class="logo">Catella Residential</div>
  <div class="sub">Pipeline lead automation</div>
  ${error}
  <form method="POST" action="/login">
    <input type="hidden" name="next" value="${next.replace(/"/g,'&quot;')}">
    <label for="pwd">Mot de passe</label>
    <input type="password" id="pwd" name="password" autofocus autocomplete="current-password" placeholder="••••••••">
    <button type="submit">Se connecter</button>
  </form>
</div></body></html>`);
});

// POST /login — vérification mot de passe
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { password, next } = req.body || {};
  const redirectNext = (next && next.startsWith('/') && !next.startsWith('//')) ? next : '/';
  if (!CONFIG.DASHBOARD_PASSWORD || password === CONFIG.DASHBOARD_PASSWORD) {
    setDashboardCookie(res);
    return res.redirect(redirectNext);
  }
  res.redirect('/login?err=1&next=' + encodeURIComponent(redirectNext));
});

// GET /logout
app.get('/logout', (req, res) => {
  clearDashboardCookie(res);
  res.redirect('/login');
});

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
    processedDateRange: (() => {
      const ts = processedLeads.map(r => new Date(r.processedAt || r.receivedAt || 0).getTime()).filter(t => t > 0);
      if (!ts.length) return { oldest: null, newest: null };
      return { oldest: new Date(Math.min(...ts)).toISOString(), newest: new Date(Math.max(...ts)).toISOString() };
    })(),
    programmes: Object.keys(PROGRAMMES).length,
    config: {
      delayHours: CONFIG.DELAY_HOURS,
      schedulerIntervalMs: CONFIG.SCHEDULER_INTERVAL_MS,
      instantProgramIds: [...INSTANT_PROGRAM_SET],
      j15Enabled: CONFIG.J15_ENABLED,
      j15DelayDays: CONFIG.J15_DELAY_DAYS,
      j15CronHourParis: CONFIG.J15_CRON_HOUR_PARIS,
      j15WhatsappEnabled: CONFIG.WHATSAPP_J15_ENABLED,
      j15WhatsappReady: CONFIG.WHATSAPP_J15_ENABLED && !!CONFIG.TWILIO_TEMPLATE_J16,
      j3mEnabled: CONFIG.J3M_ENABLED,
      j3mSendDisabled: CONFIG.J3M_SEND_DISABLED,
      j3mCronHourParis: CONFIG.J3M_CRON_HOUR_PARIS,
      j3mWhatsappEnabled: CONFIG.WHATSAPP_J3M_ENABLED,
      j3mTemplateDay2Configured: !!CONFIG.TWILIO_TEMPLATE_J3M_DAY2,
      j1AutoSendDisabled: CONFIG.J1_AUTO_SEND_DISABLED,
      j16TemplateConfigured: !!CONFIG.TWILIO_TEMPLATE_J16,
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
  // Enrichissement programName : si record.programName est manquant ou
  // matche le fallback "Programme #XXX", on remplace par le cache si dispo.
  // Sinon on laisse tel quel.
  const BAD = /^Programme #\d+$/;
  const enriched = processedLeads.slice().map(r => {
    const needsResolve = !r.programName || BAD.test(r.programName);
    return needsResolve && programNameCache.get(String(r.programId))
      ? { ...r, programName: programNameCache.get(String(r.programId)) }
      : r;
  }).sort((a, b) => {
    const ta = new Date(a.processedAt || a.receivedAt || 0).getTime();
    const tb = new Date(b.processedAt || b.receivedAt || 0).getTime();
    return tb - ta; // décroissant — récents en premier
  });
  res.json(enriched);
});

// Leads ayant déjà reçu au moins une relance J+3
app.get('/api/j3m/relanced', (req, res) => {
  const BAD = /^Programme #\d+$/;
  const leads = processedLeads.filter(l => (l.j3mRelances || 0) > 0).slice().reverse().map(r => {
    const needsResolve = !r.programName || BAD.test(r.programName);
    const programName = needsResolve ? (programNameCache.get(String(r.programId)) || r.programName) : r.programName;
    return { ...r, programName };
  });
  res.json(leads);
});

// Leads ayant déjà reçu au moins une relance J+15
app.get('/api/j15/relanced', (req, res) => {
  const BAD = /^Programme #\d+$/;
  const leads = processedLeads.filter(l => (l.j15Relances || 0) > 0).slice().reverse().map(r => {
    const needsResolve = !r.programName || BAD.test(r.programName);
    const programName = needsResolve ? (programNameCache.get(String(r.programId)) || r.programName) : r.programName;
    return { ...r, programName };
  });
  res.json(leads);
});

app.get('/api/pending', (req, res) => {
  // Enrichissement programName via le cache global (cf programNameCache plus bas).
  const enriched = pendingLeads.slice().reverse().map(p => ({
    ...p,
    programName: programNameCache.get(String(p.programId)) || null,
  }));
  res.json(enriched);
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
  const todayParis = new Date(now).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0, 10);
  const weekAgo = now - 7 * DAY;

  // 14 derniers jours en buckets (ordre chronologique, plus ancien → plus récent)
  const byDayMap = {};
  const byDay = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const key = d.toISOString().slice(0, 10);
    const bucket = {
      date: key,
      sent: 0, cancelled: 0, optout: 0, skipped: 0, error: 0, denounced: 0, excluded: 0,
      whatsappSent: 0, whatsappError: 0,
    };
    byDayMap[key] = bucket;
    byDay.push(bucket);
  }

  const counts = { sent: 0, cancelled: 0, optout: 0, skipped: 0, error: 0, denounced: 0, excluded: 0 };
  const whatsapp = { enabledLeads: 0, sent: 0, error: 0, skipped: 0, delivered: 0, read: 0, failed: 0 };
  let manualOverrideCount = 0;
  // byProgram enrichi : pour chaque programme on stocke un objet avec le détail
  // des statuts au lieu d'un simple total, pour pouvoir afficher un mini-tableau
  // dans le dashboard (sent / denounced / failClosed / taux).
  const byProgram = {};
  const today = { sent: 0, cancelled: 0, optout: 0, denounced: 0, excluded: 0, skipped: 0, total: 0, whatsappSent: 0, whatsappError: 0, failClosed: 0 };
  const week  = { sent: 0, cancelled: 0, optout: 0, denounced: 0, excluded: 0, skipped: 0, total: 0, whatsappSent: 0, whatsappError: 0, failClosed: 0 };
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
    //    Si WHATSAPP_PROD_START_DATE défini, on exclut les envois antérieurs (sandbox).
    const waAfterProdStart = !CONFIG.WHATSAPP_PROD_START_DATE || dayKey >= CONFIG.WHATSAPP_PROD_START_DATE;
    if (st === 'sent' && l.whatsappEnabled && waAfterProdStart) {
      whatsapp.enabledLeads += 1;
      if (l.whatsappSid && !l.whatsappError) {
        whatsapp.sent += 1;
        if (byDayMap[dayKey]) byDayMap[dayKey].whatsappSent += 1;
        if (['delivered', 'read'].includes(l.whatsappDeliveryStatus)) whatsapp.delivered += 1;
        if (l.whatsappDeliveryStatus === 'read') whatsapp.read += 1;
        if (['failed', 'undelivered'].includes(l.whatsappDeliveryStatus)) whatsapp.failed += 1;
      } else if (l.whatsappError) {
        whatsapp.error += 1;
        if (byDayMap[dayKey]) byDayMap[dayKey].whatsappError += 1;
      } else {
        whatsapp.skipped += 1;
      }
    }

    const processedAge = now - new Date(l.processedAt || 0).getTime();
    const processedDayParis = new Date(l.processedAt || 0).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0, 10);
    if (processedDayParis === todayParis) {
      today.total += 1;
      if (today[st] !== undefined) today[st] += 1;
      if (l.registrationsFailClosed) today.failClosed += 1;
      if (st === 'sent' && l.whatsappEnabled && waAfterProdStart) {
        if (l.whatsappSid && !l.whatsappError) today.whatsappSent += 1;
        else if (l.whatsappError)              today.whatsappError += 1;
      }
    }
    if (new Date(l.processedAt || 0).getTime() >= weekAgo) {
      week.total += 1;
      if (week[st] !== undefined) week[st] += 1;
      if (l.registrationsFailClosed) week.failClosed += 1;
      if (st === 'sent' && l.whatsappEnabled && waAfterProdStart) {
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
    if (l.manualOverride) manualOverrideCount += 1;

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

  // Leads sans suite commerciale visible : envoyés il y a > 3 jours, pas de réponse WA
  // On exclut les leadId null (records reconstruits post-ENOSPC) des deux côtés
  // pour éviter que null ∈ repliedLeadIds fasse passer tous les rebuilt comme "répondu".
  const THREE_DAYS = 3 * DAY;
  const repliedLeadIds = new Set(
    processedLeads
      .filter(l => l.status === 'whatsapp_reply_received' && l.leadId != null)
      .map(l => l.leadId)
  );
  const noFollowUpCount = processedLeads.filter(l =>
    l.status === 'sent' &&
    l.leadId != null &&
    (now - new Date(l.processedAt || 0).getTime()) > THREE_DAYS &&
    !repliedLeadIds.has(l.leadId)
  ).length;

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
    manualOverrideCount,
    noFollowUpCount,
    j3m: {
      enabled: CONFIG.J3M_ENABLED,
      sendDisabled: CONFIG.J3M_SEND_DISABLED,
      lastRunYmd: lastJ3MRunYmd,
      relancedLeads: processedLeads.filter(l => (l.j3mRelances || 0) > 0).length,
      totalSends: processedLeads.reduce((s, l) => s + (l.j3mRelances || 0), 0),
      todaySent: lastJ3MRunReport?.ymd === todayParis ? (lastJ3MRunReport.sent || 0) : 0,
      lastRunReport: lastJ3MRunReport,
    },
    j15: {
      enabled: CONFIG.J15_ENABLED,
      sendDisabled: CONFIG.J15_SEND_DISABLED,
      lastRunYmd: lastJ15RunYmd,
      relancedLeads: processedLeads.filter(l => (l.j15Relances || 0) > 0).length,
      totalSends: processedLeads.reduce((s, l) => s + (l.j15Relances || 0), 0),
      todaySent: lastJ15RunReport?.ymd === todayParis ? (lastJ15RunReport.sent || 0) : 0,
      lastRunReport: lastJ15RunReport,
    },
  });
});

app.post('/api/scheduler/run', async (req, res) => {
  await schedulerTick();
  res.json({ triggered: true, pending: pendingLeads.length });
});

// POST /api/test/email-preview — envoie un email de test avec le template choisi
// Body : { template: "j1"|"j3-day1"|"j3-day2"|"j3-day3"|"j15-day1"|"j15-day2"|"j15-day3", to?: "email", programName?: "...", salutation?: "..." }
app.post('/api/test/email-preview', async (req, res) => {
  const { template = 'j3-day1', to, programName = 'Esprit Montmartre', salutation = 'Monsieur Martin' } = req.body || {};
  const dest = to || 'norman.dadon@catella.com';
  const accroche = 'Au cœur de Montmartre, une résidence d\'exception alliant charme haussmannien et prestations contemporaines.';
  let subject, html;
  const mockContact = { title: 'mr', fullname: 'Pierre Martin' };
  const sal = buildSalutation ? buildSalutation(mockContact) : salutation;
  if (template === 'j1') {
    const ctx = {
      ville: 'Paris', programme: programName, promoteur: 'Promoteur Test',
      salutation: sal,
      brochureUrl: getBrochureUrl(programName),
    };
    subject = buildEmailSubject(ctx);
    html = buildEmailBody(ctx, accroche);
  } else if (template === 'j3-day1') {
    ({ subject, html } = buildJ3MEmailDay1(sal, programName, accroche));
  } else if (template === 'j3-day2') {
    ({ subject, html } = buildJ3MEmailDay2Fallback(sal, programName, accroche));
  } else if (template === 'j3-day3') {
    ({ subject, html } = buildJ3MEmailDay3(sal, programName, accroche));
  } else if (template === 'j15-day1') {
    ({ subject, html } = buildJ15Day1Email(sal, programName, accroche));
  } else if (template === 'j15-day2') {
    ({ subject, html } = buildJ15Day2Fallback(sal, programName, accroche));
  } else if (template === 'j15-day3') {
    ({ subject, html } = buildJ15Day3Email(sal, programName, accroche));
  } else {
    return res.status(400).json({ error: `template inconnu: ${template}` });
  }
  subject = `[TEST ${template}] ${subject}`;
  try {
    await sendEmailViaPowerAutomate(dest, subject, html);
    res.json({ ok: true, template, to: dest, subject });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    manualSource: true,
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

// Admin : enregistre une relance "test" dans le tracking inboxWatcher, pour
// permettre à Norman de valider end-to-end le flow PA en s'envoyant un mail
// à lui-même depuis un compte externe. Body : { contactEmail, contactName?,
// leadId?, programId?, programName?, subject? }. À supprimer manuellement après.
app.post('/api/admin/register-test-relance', (req, res) => {
  const b = req.body || {};
  if (!b.contactEmail) return res.status(400).json({ error: 'contactEmail requis' });
  try {
    inboxWatcher.registerSentRelance({
      leadId:        b.leadId        || 999999,
      programId:     b.programId     || 611,
      contactEmail:  String(b.contactEmail).toLowerCase().trim(),
      contactName:   b.contactName   || 'Test',
      programName:   b.programName   || 'Cristallerie',
      subject:       b.subject       || 'Votre projet à Sèvres — quelques précisions sur « Cristallerie »',
    });
    res.json({ ok: true, registered: {
      contactEmail: b.contactEmail, leadId: b.leadId || 999999,
      programId: b.programId || 611, programName: b.programName || 'Cristallerie',
    }});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin : ré-injecte les leads finalisés en 'j1-manual-pending' dans la queue
// pendingLeads pour qu'ils soient traités par le scheduler au prochain tick.
// À appeler après bascule J1_AUTO_SEND_DISABLED=true → false. Idempotent (peut
// être rappelé sans risque, ne fait rien s'il n'y a plus de j1-manual-pending).
app.post('/api/admin/rehydrate-j1-manual-pending', (req, res) => {
  const toRehydrate = processedLeads.filter(r => r.status === 'j1-manual-pending');
  const count = toRehydrate.length;
  const nowIso = new Date().toISOString();
  for (const r of toRehydrate) {
    pendingLeads.push({
      interestId: r.interestId || r.id,
      leadId: r.leadId,
      programId: r.programId,
      receivedAt: r.receivedAt || nowIso,
      checkAt: nowIso, // traité au prochain tick scheduler
      attempts: 0,
      maxAttempts: 3,
      rehydratedFrom: 'j1-manual-pending',
      rehydratedAt: nowIso,
    });
  }
  // Filter out from processedLeads (parcours arrière pour splice safe).
  const before = processedLeads.length;
  for (let i = processedLeads.length - 1; i >= 0; i--) {
    if (processedLeads[i].status === 'j1-manual-pending') {
      processedLeads.splice(i, 1);
    }
  }
  const removed = before - processedLeads.length;
  savePending();
  saveProcessed();
  res.json({
    rehydrated: count,
    removedFromProcessed: removed,
    pendingNow: pendingLeads.length,
    message: `${count} leads ré-injectés en queue. Scheduler les traitera au prochain tick (≤5 min).`,
  });
});

// Admin : batch-résolution des programNames inconnus côté Adlead.
// Itère sur les programIds uniques avec un fallback "Programme #XXX" dans
// processedLeads/pendingLeads, appelle fetchProgram pour chaque, peuple le
// cache. Throttle 1.1s entre chaque pour respecter rate limit Adlead.
// Idempotent — peut être rappelé sans risque.
app.post('/api/admin/resolve-program-names', async (req, res) => {
  const unknownIds = new Set();
  // Collecte les programIds qui n'ont pas encore de nom propre dans le cache.
  for (const r of [...processedLeads, ...pendingLeads]) {
    if (!r.programId) continue;
    const key = String(r.programId);
    if (programNameCache.has(key)) continue;
    if (r.programName && !BAD_PROGRAM_NAME.test(r.programName)) continue; // déjà propre
    unknownIds.add(key);
  }
  const ids = [...unknownIds];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let resolved = 0, stillUnknown = 0, errors = 0;
  for (let i = 0; i < ids.length; i++) {
    if (i > 0) await sleep(1100); // throttle Adlead
    const id = ids[i];
    try {
      const prog = await fetchProgram(id);
      const name = prog?.name || prog?.nom_commercial || null;
      if (name) {
        programNameCache.set(id, name);
        resolved++;
      } else {
        stillUnknown++;
      }
    } catch (e) {
      errors++;
      console.error(`[resolve-program-names] ${id} échec:`, e.message);
    }
  }
  if (resolved > 0) saveProgramNameCache();
  res.json({
    totalUnique: ids.length,
    resolved,
    stillUnknown,
    errors,
    cacheSize: programNameCache.size,
  });
});

// Admin : rétrofitte le programName des records processedLeads à partir du
// programNameCache (peuplé par /api/admin/resolve-program-names). Aucune
// requête réseau, juste un remplacement en mémoire + saveProcessed().
// Utile pour nettoyer l'affichage "Programme #XXX" dans le dashboard quand
// le cache a résolu le nom mais que les anciens records persistés gardent
// le placeholder. Idempotent.
app.post('/api/admin/backfill-program-names', (req, res) => {
  const BAD_NAME = /^Programme #\d+$/;
  let updated = 0, missingInCache = 0, alreadyClean = 0;
  for (const r of processedLeads) {
    if (!r.programId) continue;
    const isBad = !r.programName || BAD_NAME.test(r.programName);
    if (!isBad) { alreadyClean++; continue; }
    const cached = programNameCache.get(String(r.programId));
    if (cached) {
      r.programName = cached;
      updated++;
    } else {
      missingInCache++;
    }
  }
  if (updated > 0) saveProcessed();
  res.json({
    updated,
    missingInCache,
    alreadyClean,
    totalProcessed: processedLeads.length,
    cacheSize: programNameCache.size,
  });
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

// Admin : backfill statuts de livraison WhatsApp via Twilio API.
// Pour chaque lead avec whatsappSid + pas encore de whatsappDeliveryStatus,
// on interroge GET /Messages/{sid}.json et on stocke le statut réel.
// À appeler une seule fois après le déploiement du delivery tracking.
app.post('/api/admin/backfill-wa-status', async (req, res) => {
  if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN) {
    return res.status(400).json({ error: 'Twilio non configuré' });
  }
  const auth = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');
  const candidates = processedLeads.filter(l =>
    l.whatsappSid && !l.whatsappError && !l.whatsappDeliveryStatus &&
    (!CONFIG.WHATSAPP_PROD_START_DATE || (l.processedAt || '').slice(0, 10) >= CONFIG.WHATSAPP_PROD_START_DATE)
  );
  const results = [];
  for (const record of candidates) {
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages/${record.whatsappSid}.json`;
      const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (!r.ok) { results.push({ leadId: record.leadId, sid: record.whatsappSid, error: `HTTP ${r.status}` }); continue; }
      const data = await r.json();
      const status = (data.status || '').toLowerCase();
      const prevRank = WA_STATUS_RANK[record.whatsappDeliveryStatus] ?? -2;
      const newRank  = WA_STATUS_RANK[status] ?? -2;
      if (newRank > prevRank) {
        record.whatsappDeliveryStatus = status;
        if (status === 'delivered' && !record.whatsappDeliveredAt) record.whatsappDeliveredAt = data.date_updated || new Date().toISOString();
        if (status === 'read'      && !record.whatsappReadAt)      record.whatsappReadAt      = data.date_updated || new Date().toISOString();
      }
      results.push({ leadId: record.leadId, sid: record.whatsappSid, status, programName: record.programName });
    } catch (e) {
      results.push({ leadId: record.leadId, sid: record.whatsappSid, error: e.message });
    }
    await new Promise(r => setTimeout(r, 200)); // throttle Twilio API
  }
  saveProcessed();
  const summary = results.reduce((acc, r) => { acc[r.status || r.error || 'unknown'] = (acc[r.status || r.error || 'unknown'] || 0) + 1; return acc; }, {});
  console.log(`[admin/backfill-wa-status] ${candidates.length} SID(s) traités:`, summary);
  res.json({ processed: candidates.length, summary, results });
});

// POST /api/admin/backfill-whatsapp-replies
// Interroge l'API Twilio (SANS filtre To — pour ne rien rater) et injecte tous les
// messages WhatsApp inbound dans processedLeads. Idempotent par SID.
// Body JSON optionnel : { dateSentAfter: "2026-04-01" } pour limiter la plage de dates.
app.post('/api/admin/backfill-whatsapp-replies', async (req, res) => {
  if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN) {
    return res.status(400).json({ error: 'Twilio non configuré' });
  }
  const auth = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');
  const { dateSentAfter } = req.body || {};

  // SIDs déjà en base → dédoublonnage idempotent
  const existingSids = new Set(
    processedLeads.filter(l => l.whatsappMessageSid).map(l => l.whatsappMessageSid)
  );

  const normalizeForMatch = (s) => String(s || '').replace(/[^\d+]/g, '');

  // Récupère TOUTES les pages (pas de filtre To — on filtre en local)
  let allMessages = [];
  const params = new URLSearchParams({ PageSize: '100' });
  // DateSent> = filtre Twilio "après cette date" (format YYYY-MM-DD)
  if (dateSentAfter) params.append('DateSent>', dateSentAfter);
  let nextPageUrl = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json?${params.toString()}`;

  let pageCount = 0;
  while (nextPageUrl && pageCount < 50) { // garde-fou 50 pages max (5000 messages)
    const r = await fetch(nextPageUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.status(502).json({ error: `Twilio API ${r.status}`, detail: errText.slice(0, 300) });
    }
    const data = await r.json();
    // Garde uniquement les messages WhatsApp inbound (from = whatsapp:+XX)
    const inbound = (data.messages || []).filter(m =>
      m.direction === 'inbound' &&
      (String(m.from || '').startsWith('whatsapp:') || String(m.to || '').startsWith('whatsapp:'))
    );
    allMessages = allMessages.concat(inbound);
    nextPageUrl = data.next_page_uri ? `https://api.twilio.com${data.next_page_uri}` : null;
    pageCount++;
    await new Promise(resolve => setTimeout(resolve, 120)); // throttle API Twilio
  }

  console.log(`[admin/backfill-wa-replies] ${allMessages.length} messages WA inbound trouvés (${pageCount} pages Twilio)`);

  let inserted = 0;
  let skipped  = 0;
  const insertedList = [];

  for (const msg of allMessages) {
    const msgSid = msg.sid;
    if (existingSids.has(msgSid)) { skipped++; continue; }

    const fromRaw  = String(msg.from || '');
    const fromE164 = fromRaw.replace(/^whatsapp:/, '').trim();
    const body     = String(msg.body || '').trim();
    const receivedAt = msg.date_sent || msg.date_created || new Date().toISOString();
    const fromNorm = normalizeForMatch(fromE164);

    // Cherche le lead "sent" le plus récent avec ce numéro
    let match = null;
    for (let i = processedLeads.length - 1; i >= 0; i--) {
      const l = processedLeads[i];
      if (l.status !== 'sent') continue;
      if (!l.whatsappTo) continue;
      if (normalizeForMatch(l.whatsappTo) === fromNorm) { match = l; break; }
    }

    const record = {
      id: `wa-reply-backfill-${msgSid}`,
      status: 'whatsapp_reply_received',
      leadId:              match ? match.leadId      : null,
      programId:           match ? match.programId   : null,
      programName:         match ? match.programName : null,
      contactName:         match ? match.contactName : null,
      whatsappFrom:        fromE164,
      whatsappBody:        body,
      whatsappMessageSid:  msgSid,
      whatsappProfileName: null,
      relatedSentId:       match ? match.id : null,
      matched:             !!match,
      receivedAt,
      processedAt:         new Date().toISOString(),
      backfilled:          true,
    };

    processedLeads.push(record);
    existingSids.add(msgSid);
    inserted++;
    insertedList.push({ sid: msgSid, from: fromE164, matched: !!match, leadId: match?.leadId || null, contactName: match?.contactName || null, receivedAt, body: body.slice(0, 80) });
  }

  saveProcessed();
  console.log(`[admin/backfill-wa-replies] ✅ ${inserted} insérés, ${skipped} déjà présents`);
  res.json({ total: allMessages.length, inserted, skipped, messages: insertedList });
});

// POST /api/admin/rebuild-wa-conversations
// Reconstruit processedLeads (messages WA) depuis l'historique Twilio complet.
// Récupère outbound + inbound, dédoublonne par SID, matche les numéros avec pendingLeads.
// Idempotent. Paramètre optionnel : { dateSentAfter: "2026-01-01" }
app.post('/api/admin/rebuild-wa-conversations', async (req, res) => {
  if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN) {
    return res.status(400).json({ error: 'Twilio non configuré' });
  }
  const auth = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');
  const { dateSentAfter } = req.body || {};

  const existingSids = new Set(
    processedLeads.flatMap(l => [l.whatsappSid, l.whatsappMessageSid].filter(Boolean))
  );

  const normalizePhone = (s) => String(s || '').replace(/[^\d+]/g, '');

  // Index pendingLeads par numéro normalisé pour enrichir le contexte
  const phoneIndex = {};
  for (const l of pendingLeads) {
    if (l.whatsappTo) {
      const norm = normalizePhone(l.whatsappTo);
      if (norm) phoneIndex[norm] = { contactName: l.contactName, programName: l.programName, leadId: l.leadId, programId: l.programId };
    }
  }
  // Aussi indexer les processedLeads déjà présents
  for (const l of processedLeads) {
    const phone = l.whatsappTo || l.whatsappFrom;
    if (phone && (l.contactName || l.programName)) {
      const norm = normalizePhone(phone);
      if (norm && !phoneIndex[norm]) {
        phoneIndex[norm] = { contactName: l.contactName, programName: l.programName, leadId: l.leadId, programId: l.programId };
      }
    }
  }

  // Récupère toutes les pages Twilio
  async function fetchAllMessages() {
    const params = new URLSearchParams({ PageSize: '100' });
    if (dateSentAfter) params.append('DateSent>', dateSentAfter);
    let url = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json?${params}`;
    const all = [];
    let pages = 0;
    while (url && pages < 100) {
      const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (!r.ok) throw new Error(`Twilio ${r.status}: ${await r.text().catch(() => '')}`);
      const data = await r.json();
      const waMessages = (data.messages || []).filter(m =>
        String(m.from || '').startsWith('whatsapp:') || String(m.to || '').startsWith('whatsapp:')
      );
      all.push(...waMessages);
      url = data.next_page_uri ? `https://api.twilio.com${data.next_page_uri}` : null;
      pages++;
      await new Promise(r => setTimeout(r, 100));
    }
    return all;
  }

  let allMessages;
  try {
    allMessages = await fetchAllMessages();
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  console.log(`[rebuild-wa-conv] ${allMessages.length} messages WA Twilio récupérés`);

  let inserted = 0, skipped = 0;
  const ourNumber = (CONFIG.TWILIO_WHATSAPP_FROM || '').replace(/^whatsapp:/, '');

  for (const msg of allMessages) {
    const sid = msg.sid;
    if (existingSids.has(sid)) { skipped++; continue; }

    const fromRaw = String(msg.from || '').replace(/^whatsapp:/, '');
    const toRaw   = String(msg.to   || '').replace(/^whatsapp:/, '');
    const body    = String(msg.body || '').trim();
    const time    = new Date(msg.date_sent || msg.date_created || Date.now()).toISOString();
    const isInbound  = msg.direction === 'inbound';
    const isOutbound = msg.direction === 'outbound-api' || msg.direction === 'outbound-reply';

    if (!isInbound && !isOutbound) { skipped++; continue; }

    const prospectPhone = isInbound ? fromRaw : toRaw;
    const norm          = normalizePhone(prospectPhone);
    const ctx           = phoneIndex[norm] || {};

    let record;
    if (isOutbound) {
      record = {
        id:                    `wa-out-${sid}`,
        status:                'sent',
        leadId:                ctx.leadId    || null,
        programId:             ctx.programId || null,
        programName:           ctx.programName || null,
        contactName:           ctx.contactName || null,
        whatsappSid:           sid,
        whatsappTo:            prospectPhone,
        whatsappBody:          body,
        whatsappDeliveryStatus: msg.status || null,
        processedAt:           time,
        rebuilt:               true,
      };
    } else {
      record = {
        id:                    `wa-reply-${sid}`,
        status:                'whatsapp_reply_received',
        leadId:                ctx.leadId    || null,
        programId:             ctx.programId || null,
        programName:           ctx.programName || null,
        contactName:           ctx.contactName || null,
        whatsappFrom:          prospectPhone,
        whatsappBody:          body,
        whatsappMessageSid:    sid,
        whatsappProfileName:   msg.from_formatted || null,
        receivedAt:            time,
        processedAt:           time,
        rebuilt:               true,
      };
    }

    processedLeads.push(record);
    existingSids.add(sid);
    // Enrichir phoneIndex si on a un ctx depuis un outbound qu'on vient d'insérer
    if (isOutbound && !phoneIndex[norm] && (ctx.contactName || ctx.programName)) {
      phoneIndex[norm] = ctx;
    }
    inserted++;
  }

  saveProcessed();
  const byPhone = {};
  for (const l of processedLeads) {
    const p = l.whatsappTo || l.whatsappFrom;
    if (p) byPhone[p] = true;
  }
  console.log(`[rebuild-wa-conv] ✅ ${inserted} insérés, ${skipped} déjà présents, ${Object.keys(byPhone).length} numéros uniques`);
  res.json({ total: allMessages.length, inserted, skipped, phones: Object.keys(byPhone).length });
});

// POST /api/admin/enrich-wa-records
// Backfille programName / contactName manquants sur les records WA en scannant
// les corps de messages (templates résolus stockés par Twilio).
app.post('/api/admin/enrich-wa-records', (req, res) => {
  const normPhone = s => String(s || '').replace(/[^\d+]/g, '');

  // Grouper par numéro de téléphone
  const byPhone = {};
  for (const l of processedLeads) {
    const phone = normPhone(l.whatsappTo || l.whatsappFrom);
    if (!phone) continue;
    if (!byPhone[phone]) byPhone[phone] = [];
    byPhone[phone].push(l);
  }

  let updatedRecords = 0;
  for (const records of Object.values(byPhone)) {
    // Cherche si un record a déjà un vrai programName
    const existing = records.find(r => r.programName && !BAD_PROGRAM_NAME.test(r.programName));
    const existingName = records.find(r => r.contactName);
    if (existing && existingName) continue; // tout est déjà enrichi

    const msgs = records.map(r => ({ body: r.whatsappBody || '' }));
    const name = existingName ? existingName.contactName : extractNameFromBodies(msgs);
    const prog = existing ? existing.programName : extractProgramFromBodies(msgs);
    if (!name && !prog) continue;

    for (const r of records) {
      let changed = false;
      if (!r.contactName && name) { r.contactName = name; changed = true; }
      if ((!r.programName || BAD_PROGRAM_NAME.test(r.programName)) && prog) { r.programName = prog; changed = true; }
      if (changed) updatedRecords++;
    }
  }

  if (updatedRecords > 0) saveProcessed();
  console.log(`[enrich-wa-records] ${updatedRecords} records mis à jour`);
  res.json({ ok: true, updated: updatedRecords });
});

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

// ─── WHATSAPP CONVERSATIONS ─────────────────────────────────────────────────
// GET /api/whatsapp/conversations
// Regroupe tous les messages WhatsApp (envoyés + reçus + réponses Norman) par
// numéro de téléphone prospect, pour alimenter l'interface de chat du dashboard.
app.get('/api/whatsapp/conversations', (req, res) => {
  const convMap = {};

  for (const l of processedLeads) {
    let phone = null;
    let direction = null;

    if (l.status === 'sent' && l.whatsappSid && l.whatsappTo) {
      phone = l.whatsappTo;
      direction = 'out';
    } else if (l.status === 'whatsapp_reply_received' && l.whatsappFrom) {
      phone = l.whatsappFrom;
      direction = 'in';
    } else if (l.status === 'whatsapp_reply_sent' && l.whatsappTo) {
      phone = l.whatsappTo;
      direction = 'out';
    }

    if (!phone) continue;

    if (!convMap[phone]) {
      convMap[phone] = {
        phone,
        contactName: null,
        programName: null,
        leadId: null,
        programId: null,
        messages: [],
        lastActivity: null,
        lastInboundAt: null,
      };
    }

    const conv = convMap[phone];
    if (l.contactName && !conv.contactName) conv.contactName = l.contactName;
    if (l.programName  && !conv.programName)  conv.programName  = l.programName;
    if (l.leadId       && !conv.leadId)        conv.leadId       = l.leadId;
    if (l.programId    && !conv.programId)     conv.programId    = l.programId;

    const msgTime = l.processedAt || l.receivedAt || l.sentAt;
    conv.messages.push({
      id:          l.id,
      direction,
      body:        l.whatsappBody || '',
      time:        msgTime,
      sid:         l.whatsappSid || l.whatsappMessageSid || null,
      profileName: l.whatsappProfileName || null,
      isTemplate:  l.status === 'sent',
    });

    if (!conv.lastActivity || msgTime > conv.lastActivity) conv.lastActivity = msgTime;
    if (direction === 'in' && (!conv.lastInboundAt || msgTime > conv.lastInboundAt)) {
      conv.lastInboundAt = msgTime;
    }
  }

  // Index inboxWatcher par (prénom_norm, programme_norm) → { leadId, programId, contactName }
  const _relances = inboxWatcher.getRecentRelances(500);
  const _relanceIdx = {};
  for (const r of _relances) {
    if (!r.leadId || !r.programId) continue;
    const firstName = (r.contactName || '').split(/\s+/)[0].normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase();
    const prog      = (r.programName || '').normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const key = `${firstName}||${prog}`;
    if (!_relanceIdx[key]) _relanceIdx[key] = r;
  }

  const conversations = Object.values(convMap)
    .filter(c => c.messages.some(m => m.direction === 'in'))
    .map(c => {
      c.messages.sort((a, b) => new Date(a.time) - new Date(b.time));
      // Enrichissement on-the-fly si métadonnées manquantes (ex: après rebuild depuis Twilio)
      if (!c.contactName) c.contactName = extractNameFromBodies(c.messages);
      if (!c.programName) c.programName = extractProgramFromBodies(c.messages);
      // Si leadId/programId manquants, chercher dans inboxWatcher par prénom+programme
      if ((!c.leadId || !c.programId) && c.contactName && c.programName) {
        const fn   = c.contactName.normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase();
        const prog = c.programName.normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'');
        const hit  = _relanceIdx[`${fn}||${prog}`];
        if (hit) {
          if (!c.leadId)    c.leadId    = hit.leadId;
          if (!c.programId) c.programId = hit.programId;
          if (!c.contactName || c.contactName === fn) c.contactName = hit.contactName;
        }
      }
      // Fenêtre libre Meta : 24h après le dernier message entrant
      const windowExpiresAt = c.lastInboundAt
        ? new Date(new Date(c.lastInboundAt).getTime() + 24 * 60 * 60 * 1000).toISOString()
        : null;
      const windowOpen = windowExpiresAt ? new Date() < new Date(windowExpiresAt) : false;
      return { ...c, windowExpiresAt, windowOpen };
    })
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  res.json(conversations);
});

// GET /conversations — page autonome (pas de modal, pas de CSS complexe)
app.get('/conversations', (req, res) => {
  const convMap = {};
  for (const l of processedLeads) {
    let phone = null, direction = null;
    if (l.status === 'sent' && l.whatsappSid && l.whatsappTo)           { phone = l.whatsappTo;   direction = 'out'; }
    else if (l.status === 'whatsapp_reply_received' && l.whatsappFrom)  { phone = l.whatsappFrom; direction = 'in';  }
    else if (l.status === 'whatsapp_reply_sent' && l.whatsappTo)        { phone = l.whatsappTo;   direction = 'out'; }
    if (!phone) continue;
    if (!convMap[phone]) convMap[phone] = { phone, contactName: null, programName: null, leadId: null, programId: null, messages: [], lastActivity: null, lastInboundAt: null };
    const conv = convMap[phone];
    if (l.contactName && !conv.contactName) conv.contactName = l.contactName;
    if (l.programName && !conv.programName) conv.programName = l.programName;
    if (l.leadId      && !conv.leadId)      conv.leadId      = l.leadId;
    if (l.programId   && !conv.programId)   conv.programId   = l.programId;
    const t = l.processedAt || l.receivedAt || l.sentAt;
    conv.messages.push({ direction, body: l.whatsappBody || '', time: t, isTemplate: l.status === 'sent' });
    if (!conv.lastActivity || t > conv.lastActivity) conv.lastActivity = t;
    if (direction === 'in' && (!conv.lastInboundAt || t > conv.lastInboundAt)) conv.lastInboundAt = t;
  }

  const convs = Object.values(convMap)
    .filter(c => c.messages.some(m => m.direction === 'in'))
    .map(c => {
      c.messages.sort((a, b) => new Date(a.time) - new Date(b.time));
      if (!c.contactName) {
        for (const m of c.messages) {
          const hit = (m.body || '').match(/Bonjour\s+([A-ZÀ-Ÿa-zà-ÿ][a-zà-ÿ\-]+)[,\n]/);
          if (hit) { c.contactName = hit[1].charAt(0).toUpperCase() + hit[1].slice(1); break; }
        }
      }
      if (!c.programName) {
        for (const m of c.messages) {
          const hit = (m.body || '').match(/programme\s+([A-ZÀÉÈÊËÎÏÔÙÛÜ0-9][^\n,.]{2,40})/i);
          if (hit) { c.programName = hit[1].trim().replace(/\.$/, ''); break; }
        }
      }
      const exp = c.lastInboundAt ? new Date(new Date(c.lastInboundAt).getTime() + 86400000).toISOString() : null;
      return { ...c, windowOpen: exp ? new Date() < new Date(exp) : false, windowExpiresAt: exp };
    })
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmtDate = iso => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };

  const cardsHtml = convs.map((c, i) => {
    const name = c.contactName || c.phone || '—';
    const prog = c.programName || '—';
    const adUrl = c.leadId && c.programId ? buildAdleadLeadUrl(c.programId, c.leadId) : null;
    const windowBadge = c.windowOpen
      ? '<span style="background:#e8f7ee;color:#1d7a3a;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;">✓ Fenêtre ouverte — tu peux répondre</span>'
      : '<span style="background:#f0f0f2;color:#6e6e73;padding:2px 10px;border-radius:20px;font-size:12px;">Fenêtre expirée</span>';

    const bubblesHtml = c.messages.map(m => {
      const isIn = m.direction === 'in';
      const bg  = m.isTemplate ? '#f5f5f7' : (isIn ? '#dcf8c6' : '#e5f1ff');
      const col = '#1d1d1f';
      const align = isIn ? 'left' : 'right';
      const margin = isIn ? 'margin-right:60px' : 'margin-left:60px';
      return `<div style="background:${bg};color:${col};padding:10px 14px;border-radius:12px;margin:4px 0;${margin};text-align:${align};">
        ${m.isTemplate ? '<em style="color:#6e6e73;">(message auto envoyé)</em>' : esc(m.body || '(image ou fichier)')}
        <div style="font-size:11px;color:#6e6e73;margin-top:4px;">${fmtDate(m.time)}</div>
      </div>`;
    }).join('');

    const replyInput = c.windowOpen ? `
      <div class="reply-form" style="display:flex;gap:8px;margin-top:12px;"
        data-phone="${esc(c.phone)}"
        data-lead-id="${esc(c.leadId || '')}"
        data-program-id="${esc(c.programId || '')}"
        data-contact-name="${esc(c.contactName || '')}"
        data-program-name="${esc(c.programName || '')}">
        <textarea placeholder="Écrire un message…" rows="2" style="flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;"></textarea>
        <button style="padding:10px 20px;background:#25D366;color:white;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;">Envoyer</button>
      </div>` : `<p style="color:#6e6e73;font-size:13px;margin-top:8px;">Fenêtre 24h expirée — impossible de répondre en message libre (règle Meta).</p>`;

    return `<div style="background:white;border:1px solid #e5e5ea;border-radius:12px;padding:16px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-weight:700;font-size:16px;color:#1d1d1f;">${esc(name)}</div>
          <div style="font-size:13px;color:#6e6e73;margin-top:2px;">${esc(prog)} · ${esc(c.phone)}</div>
          ${adUrl ? `<a href="${esc(adUrl)}" target="_blank" style="font-size:12px;color:#0070f3;">Ouvrir dans Adlead ↗</a>` : ''}
        </div>
        ${windowBadge}
      </div>
      <div style="background:#f5f5f7;border-radius:8px;padding:12px;">${bubblesHtml || '<em style="color:#6e6e73;">Aucun message texte</em>'}</div>
      ${replyInput}
    </div>`;
  }).join('');

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Conversations WhatsApp — Catella</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; margin: 0; padding: 0; color: #1d1d1f; }
    .header { background: white; padding: 16px 24px; border-bottom: 1px solid #e5e5ea; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 10; }
    .container { max-width: 720px; margin: 0 auto; padding: 24px 16px; }
    button:hover { opacity: 0.85; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <strong style="font-size:18px;">💬 Conversations WhatsApp</strong>
      <div style="font-size:13px;color:#6e6e73;margin-top:2px;">${convs.length} conversation${convs.length !== 1 ? 's' : ''} · ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</div>
    </div>
    <a href="/" style="font-size:13px;color:#0070f3;text-decoration:none;">← Dashboard</a>
  </div>
  <div class="container">
    ${convs.length ? cardsHtml : '<div style="text-align:center;padding:60px;color:#6e6e73;">Aucune réponse WhatsApp reçue pour le moment.</div>'}
  </div>
  <script>
    setTimeout(() => location.reload(), 60000);

    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.reply-form button');
      if (!btn) return;
      const form = btn.closest('.reply-form');
      const textarea = form.querySelector('textarea');
      const body = textarea.value.trim();
      if (!body) return;

      btn.disabled = true;
      btn.textContent = '…';

      const payload = {
        to:          form.dataset.phone,
        body,
        leadId:      form.dataset.leadId,
        programId:   form.dataset.programId,
        contactName: form.dataset.contactName,
        programName: form.dataset.programName,
      };

      try {
        const r = await fetch('/api/whatsapp/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await r.json();
        if (!r.ok || !json.ok) throw new Error(json.error || r.status);

        // Append sent bubble to the messages container above this form
        const container = form.previousElementSibling;
        if (container) {
          const now = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
          const bubble = document.createElement('div');
          bubble.style.cssText = 'background:#dcf8c6;color:#1d1d1f;padding:10px 14px;border-radius:12px;margin:4px 0;margin-left:60px;text-align:right;';
          bubble.innerHTML = body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') +
            '<div style="font-size:11px;color:#6e6e73;margin-top:4px;">' + now + '</div>';
          container.appendChild(bubble);
          container.scrollTop = container.scrollHeight;
        }

        textarea.value = '';
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = 'Envoyer'; btn.disabled = false; }, 2000);
      } catch (err) {
        btn.textContent = 'Erreur';
        btn.style.background = '#ff3b30';
        setTimeout(() => { btn.textContent = 'Envoyer'; btn.style.background = '#25D366'; btn.disabled = false; }, 3000);
      }
    });
  </script>
</body>
</html>`);
});

// POST /conversations/reply — traite la réponse envoyée depuis /conversations
app.post('/conversations/reply', express.urlencoded({ extended: false }), async (req, res) => {
  const { to, body, leadId, programId, contactName, programName } = req.body || {};
  if (!to || !body) return res.redirect('/conversations?err=missing');
  try {
    const resp = await sendWhatsAppViaTwilio(to, body);
    processedLeads.push({ id: `wa-sent-${Date.now()}`, status: 'whatsapp_reply_sent', leadId: leadId || null, programId: programId || null, programName: programName || null, contactName: contactName || null, whatsappTo: to, whatsappBody: body, whatsappSid: resp.sid || null, processedAt: new Date().toISOString() });
    saveProcessed();
    res.redirect('/conversations?sent=1');
  } catch (e) {
    res.redirect(`/conversations?err=${encodeURIComponent(e.message)}`);
  }
});

// POST /api/whatsapp/reply
// Envoie un message libre à un prospect (dans la fenêtre 24h Meta) et le stocke.
app.post('/api/whatsapp/reply', async (req, res) => {
  const { to, body, leadId, programId, contactName, programName } = req.body || {};
  if (!to || !body) return res.status(400).json({ error: 'to et body requis' });
  if (!CONFIG.TWILIO_ACCOUNT_SID) return res.status(503).json({ error: 'Twilio non configuré' });

  // Vérification fenêtre 24h Meta côté serveur
  const normTo = String(to).replace(/[^\d+]/g, '');
  const lastInbound = processedLeads
    .filter(l => l.status === 'whatsapp_reply_received' && l.whatsappFrom && String(l.whatsappFrom).replace(/[^\d+]/g, '') === normTo)
    .map(l => l.receivedAt || l.processedAt)
    .sort()
    .pop();
  if (lastInbound && (Date.now() - new Date(lastInbound).getTime()) > 24 * 60 * 60 * 1000) {
    return res.status(403).json({ ok: false, error: 'Fenêtre 24h Meta expirée — seuls les templates sont autorisés' });
  }

  try {
    const resp = await sendWhatsAppViaTwilio(to, body);
    const record = {
      id:           `wa-sent-${Date.now()}`,
      status:       'whatsapp_reply_sent',
      leadId:       leadId   || null,
      programId:    programId || null,
      programName:  programName || null,
      contactName:  contactName || null,
      whatsappTo:   to,
      whatsappBody: body,
      whatsappSid:  resp.sid || null,
      processedAt:  new Date().toISOString(),
    };
    processedLeads.push(record);
    saveProcessed();
    console.log(`[whatsapp/reply] ✅ réponse envoyée à ${to} (sid: ${resp.sid})`);
    res.json({ ok: true, sid: resp.sid });
  } catch (e) {
    console.error(`[whatsapp/reply] ⚠️ échec envoi à ${to}: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/webhook/adlead', (req, res) => {
  if (!verifyAdleadSignature(req)) {
    console.warn('[webhook] Signature invalide');
    return res.status(401).json({ error: 'Signature invalide' });
  }

  const { event } = req.body || {};
  console.log(`[webhook] Événement reçu: ${event}`);

  // ── interest:status-updated — annulation temps réel ────────────────────────
  // Adlead notifie dès qu'un commercial change le statut d'un interest.
  // Si le statut devient actif (ongoing, discarded, etc.) ET qu'on a un lead
  // en attente pour cet interest, on l'annule immédiatement sans attendre T+24h.
  if (event === 'interest:status-updated') {
    const data = req.body.data || {};
    const interestId = data.id;
    const newStatus = data.status;
    const leadId = data.context?.lead_id;

    const BLOCKING_STATUSES = new Set(['ongoing', 'to-follow', 'interested', 'negotiating', 'discarded', 'pending-purchaser', 'purchaser']);
    if (!BLOCKING_STATUSES.has(newStatus)) {
      console.log(`[webhook] interest:status-updated interest ${interestId} → statut "${newStatus}" non bloquant`);
      return res.status(200).json({ message: `Statut "${newStatus}" non bloquant` });
    }

    const idx = pendingLeads.findIndex(l => String(l.interestId) === String(interestId));
    if (idx === -1) {
      console.log(`[webhook] interest:status-updated interest ${interestId} → aucun lead en attente`);
      return res.status(200).json({ message: 'Aucun lead en attente pour cet interest' });
    }

    const entry = pendingLeads[idx];
    pendingLeads.splice(idx, 1);
    const reason = `Statut interest → "${newStatus}" détecté via webhook Adlead (temps réel)`;
    processedLeads.push({
      id: interestId,
      interestId,
      leadId: leadId || entry.leadId,
      programId: entry.programId,
      status: 'cancelled',
      reason,
      receivedAt: entry.receivedAt,
      checkAt: entry.checkAt,
      processedAt: new Date().toISOString(),
      cancelledViaWebhook: true,
    });
    savePending();
    saveProcessed();
    console.log(`[webhook] interest ${interestId} lead ${leadId || entry.leadId} — ANNULÉ temps réel : ${reason}`);
    return res.status(200).json({ message: 'Lead annulé en temps réel', interestId, newStatus });
  }

  // ── interest:deleted — suppression du lead dans Adlead ───────────────────
  if (event === 'interest:deleted') {
    const data = req.body.data || {};
    const interestId = data.id;
    const leadId = data.context?.lead_id;

    const idx = pendingLeads.findIndex(l => String(l.interestId) === String(interestId));
    if (idx === -1) {
      console.log(`[webhook] interest:deleted interest ${interestId} → aucun lead en attente`);
      return res.status(200).json({ message: 'Aucun lead en attente pour cet interest' });
    }

    const entry = pendingLeads[idx];
    pendingLeads.splice(idx, 1);
    processedLeads.push({
      id: interestId,
      interestId,
      leadId: leadId || entry.leadId,
      programId: entry.programId,
      status: 'cancelled',
      reason: 'Interest supprimé dans Adlead (interest:deleted)',
      receivedAt: entry.receivedAt,
      checkAt: entry.checkAt,
      processedAt: new Date().toISOString(),
      cancelledViaWebhook: true,
    });
    savePending();
    saveProcessed();
    console.log(`[webhook] interest:deleted interest ${interestId} — lead annulé`);
    return res.status(200).json({ message: 'Lead annulé (interest supprimé)', interestId });
  }

  if (event !== 'interest:created') {
    return res.status(200).json({ message: 'Événement ignoré' });
  }

  try {
    enqueueLead(req.body);
  } catch (err) {
    console.error('[webhook] Erreur enqueue:', err.message);
    // On retourne quand même 200 pour éviter la rélivraison Adlead (qui relivrerait en boucle).
  }
  res.status(200).json({ message: 'Reçu, en attente de traitement' });
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
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.alloc(expectedBuf.length);
  Buffer.from(provided).copy(providedBuf);
  if (!require('crypto').timingSafeEqual(expectedBuf, providedBuf)) {
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
      // STRING (pas boolean) pour compat directe avec la Condition Power Automate
      // qui compare textuellement à "true" / "false" — sinon mismatch booléen/string
      // → ActionBranchingConditionNotSatisfied.
      matched: 'false',
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
    // STRING (pas boolean) — voir comment au-dessus dans le no-match branch.
    matched: 'true',
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

// ─── WEBHOOK : Twilio status callback (delivery tracking WhatsApp) ──────────
// Twilio POST à chaque transition : queued → sent → delivered → read (ou failed/undelivered).
// URL configurée via TWILIO_STATUS_CALLBACK_URL (= param StatusCallback à l'envoi).
// On stocke le statut le plus avancé sur le record du lead (ne régresse jamais).
const WA_STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: -1, undelivered: -1 };
app.post('/webhook/twilio-status', express.urlencoded({ extended: false }), (req, res) => {
  res.sendStatus(204);
  const p = req.body || {};
  const sid    = p.MessageSid || p.SmsSid;
  const status = (p.MessageStatus || p.SmsStatus || '').toLowerCase();
  if (!sid || !status) return;

  // Cherche le lead par SID (J+1, J+3, J+15 stockent tous whatsappSid)
  const record = processedLeads.find(l =>
    l.whatsappSid === sid ||
    (l.j3mHistory  || []).some(h => h.whatsappSid === sid) ||
    (l.j15History  || []).some(h => h.whatsappSid === sid)
  );
  if (!record) return; // SID inconnu (notif interne, vieux message sandbox)

  const prevRank = WA_STATUS_RANK[record.whatsappDeliveryStatus] ?? -2;
  const newRank  = WA_STATUS_RANK[status] ?? -2;
  if (newRank > prevRank) {
    record.whatsappDeliveryStatus = status;
    if (status === 'delivered' && !record.whatsappDeliveredAt) record.whatsappDeliveredAt = new Date().toISOString();
    if (status === 'read'      && !record.whatsappReadAt)      record.whatsappReadAt      = new Date().toISOString();
    saveProcessed();
    console.log(`[twilio-status] lead ${record.leadId} SID=${sid} → ${status}`);
  }
});

// ─── WEBHOOK : Twilio "WhatsApp incoming" (réponses prospect) ───────────────
// Configuré côté Twilio : WhatsApp Senders > +13853324609 > Edit > "Webhook URL for
// incoming messages" → https://lead-automation-production-33e8.up.railway.app/webhook/whatsapp-incoming
// Méthode : HTTP POST. Twilio envoie form-urlencoded (From, To, Body, ProfileName, MessageSid…).
// Sécurité : signature HMAC SHA1 validée via x-twilio-signature (TWILIO_VALIDATE_SIGNATURE=false
// pour bypass en dev/debug seulement).
app.post('/webhook/whatsapp-incoming', express.urlencoded({ extended: false }), async (req, res) => {
  // 1. Validation signature Twilio
  // Reconstruction URL exacte pour validation signature Twilio.
  // TWILIO_WEBHOOK_BASE_URL hardcodé évite le problème Railway (x-forwarded-host absent).
  const base    = (CONFIG.TWILIO_WEBHOOK_BASE_URL || '').replace(/\/$/, '');
  const fullUrl = base
    ? `${base}${req.originalUrl}`
    : `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}${req.originalUrl}`;
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

      // Si le match existe mais a programName/contactName nuls (ex: record reconstruit post-ENOSPC),
      // extraire depuis les corps des messages connus pour ce numéro et persister dans processedLeads.
      if (match && (!match.programName || !match.contactName)) {
        const allSamePhone = processedLeads.filter(l => {
          const p = l.whatsappTo || l.whatsappFrom;
          return p && normalizeForMatch(p) === fromNorm;
        });
        const msgs = allSamePhone.map(l => ({ body: l.whatsappBody || '' }));
        const enrichedName = !match.contactName ? (extractNameFromBodies(msgs) || profileName || null) : null;
        const enrichedProg = !match.programName ? extractProgramFromBodies(msgs) : null;
        if (enrichedName || enrichedProg) {
          match = { ...match,
            contactName: enrichedName || match.contactName,
            programName: enrichedProg || match.programName,
          };
          // Persister l'enrichissement sur tous les records du même numéro
          for (const l of allSamePhone) {
            if (!l.contactName && enrichedName) l.contactName = enrichedName;
            if (!l.programName && enrichedProg)  l.programName = enrichedProg;
          }
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

      // 7. Trace dans processedLeads pour audit dashboard (idempotent par msgSid)
      if (msgSid && processedLeads.some(l => l.whatsappMessageSid === msgSid)) {
        console.log(`[webhook/whatsapp-incoming] msgSid ${msgSid} déjà présent — retry Twilio ignoré`);
        return;
      }
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

// Statuts éligibles côté records (= leads qu'on a vu passer côté nous).
// 'j1-manual-pending' = leads traités par notre pipeline mais sans envoi auto
// (J1_AUTO_SEND_DISABLED=true) ; Norman a fait l'action manuelle.
const J15_ELIGIBLE_STATUSES = new Set(['sent', 'cancelled', 'skipped', 'error', 'j1-manual-pending']);

function isJ15Candidate(record, now) {
  if (record.status !== 'sent') return false;
  if (!record.leadId || !record.programId) return false;
  if (EXCLUDED_PROGRAM_SET.has(String(record.programId))) return false;
  const refMs = new Date(record.processedAt || 0).getTime();
  if (!refMs) return false;
  const ageDays = (now - refMs) / (1000 * 60 * 60 * 24);
  const n = record.j15Relances || 0;
  // Fenêtre ouverte : >= seuil + borne haute pour éviter de boucler indéfiniment.
  // Pas de fenêtre stricte d'1 jour : si le cron saute (ex. dimanche), le lead
  // est rattrapé le lendemain au lieu d'être définitivement perdu.
  const todayYmd = new Date().toISOString().slice(0, 10);
  if (record.j15RetryAfter && todayYmd >= record.j15RetryAfter && n < 3) return true;
  if (n === 0 && ageDays >= 15 && ageDays < 25) return true;
  if (n === 1 && ageDays >= 16 && ageDays < 25) return true;
  if (n === 2 && ageDays >= 17 && ageDays < 25) return true;
  return false;
}

// ─── Templates email règle 3 (3 jours : J+15 / J+16 / J+17) ─────────────────

function buildJ15Day1Email(salutation, programName, accroche) {
  const subject = `${programName} — votre dossier toujours actif ?`;
  const html = `<p>Bonjour ${salutation},</p>
<p>Cela fait maintenant 2 semaines que je tentais de vous joindre concernant votre demande sur ${programName}. Je n'ai pas eu votre retour à mes messages précédents.</p>
${accroche ? `<p><em>${escapeHtml(accroche)}</em></p>` : ''}
<p>Avant de classer définitivement votre dossier, je souhaitais m'assurer qu'on ne passait pas à côté d'une opportunité pour vous. Le programme évolue toujours et il reste actuellement des biens disponibles.</p>
<p>Un mot de vous suffit pour que je vous transmette les éléments à jour.</p>
<p>Très cordialement,</p>
${buildFullSignature()}`;
  return { subject, html };
}

function buildJ15Day2Fallback(salutation, programName, accroche) {
  const subject = `${programName} — quelques disponibilités à étudier`;
  const html = `<p>Bonjour ${salutation},</p>
<p>Je reviens une dernière fois vers vous concernant votre demande sur ${programName}.</p>
${accroche ? `<p><em>${escapeHtml(accroche)}</em></p>` : ''}
<p>Notre stock évolue rapidement, et les meilleures opportunités partent vite. Si votre projet reste d'actualité, je peux vous transmettre les disponibilités à jour aujourd'hui.</p>
<p>Souhaitez-vous que je vous rappelle ?</p>
${buildFullSignature()}`;
  return { subject, html };
}

function buildJ15Day3Email(salutation, programName, accroche) {
  const subject = `${programName} — clôture de votre dossier`;
  const html = `<p>Bonjour ${salutation},</p>
<p>Sans nouvelles de votre part malgré mes différentes tentatives, je vais clôturer définitivement votre dossier sur ${programName} aujourd'hui.</p>
${accroche ? `<p><em>${escapeHtml(accroche)}</em></p>` : ''}
<p>Si votre projet immobilier évolue dans les semaines à venir et que vous souhaitez revoir ce programme ou d'autres opportunités de notre portefeuille, n'hésitez pas à me recontacter directement à cette adresse.</p>
<p>Je vous souhaite une bonne continuation dans vos recherches.</p>
<p>Cordialement,</p>
${buildFullSignature()}`;
  return { subject, html };
}

async function processJ15Candidate(record, { dryRun = false, sendDisabled = false } = {}) {
  const lead = await fetchLead(record.leadId, { programId: record.programId });
  if (!lead) return { skipped: true, reason: 'lead introuvable côté Adlead' };
  if (lead.is_under_prescription === true) return { skipped: true, reason: 'is_under_prescription=true' };
  if (lead.discard_reason != null) return { skipped: true, reason: `discard_reason="${lead.discard_reason}"` };

  // Status check — règle Option A : si status ≠ pending, reset counter et skip.
  if (lead.status !== 'pending') {
    let reset = false;
    if ((record.j15Relances || 0) > 0) {
      if (!dryRun) record.j15Relances = 0;
      reset = true;
    }
    return { skipped: true, reason: `lead.status="${lead.status}" (≠ pending)`, reset };
  }

  // Trigger via Adlead `last_interaction_at` (date dernière action commerciale).
  // Fallback sur record.processedAt (envoi J+1) si null — même raison que J+3.
  // Cadence J+15 / J+16 / J+17 depuis cette date :
  //   counter=0 + days>=15 → send #1 (soft last-chance)
  //   counter=1 + days>=16 → send #2 (urgence stock — WhatsApp)
  //   counter=2 + days>=17 → send #3 (clôture définitive)
  const j15RefDate = lead.last_interaction_at || record.processedAt;
  if (!j15RefDate) {
    return { skipped: true, reason: 'last_interaction_at et processedAt tous deux null' };
  }
  const daysSinceLastAction = (Date.now() - new Date(j15RefDate).getTime()) / (1000 * 60 * 60 * 24);
  const currentCount = record.j15Relances || 0;
  const thresholds = [15, 16, 17];
  const threshold = thresholds[currentCount] ?? 99;
  let dayNumber;
  if (currentCount === 0 && daysSinceLastAction >= 15) dayNumber = 1;
  else if (currentCount === 1 && daysSinceLastAction >= 16) dayNumber = 2;
  else if (currentCount === 2 && daysSinceLastAction >= 17) dayNumber = 3;
  else {
    // Stocker la date à laquelle ce lead redeviendra éligible (évite fenêtre manquée).
    const daysLeft = threshold - daysSinceLastAction;
    const retryDate = new Date(Date.now() + daysLeft * 86400000).toISOString().slice(0, 10);
    if (!record.j15RetryAfter || retryDate < record.j15RetryAfter) {
      record.j15RetryAfter = retryDate;
    }
    return {
      skipped: true,
      reason: `pas de relance prévue (j15Relances=${currentCount}, daysSinceAction=${daysSinceLastAction.toFixed(1)}, retryAfter=${record.j15RetryAfter})`,
    };
  }
  // Relance envoyée → effacer le retryAfter
  record.j15RetryAfter = null;

  // Contact + email check.
  const contact = (lead.contacts && lead.contacts[0]) || null;
  if (!contact) return { skipped: true, reason: 'aucun contact sur le lead' };
  const email = contact.email || record.email;
  if (!email) return { skipped: true, reason: "pas d'email sur le contact" };
  if (contact.has_opted_out === true || contact.opted_out_at) return { skipped: true, reason: 'contact opt-out' };

  // Résolution robuste du programName — refus du fallback "Programme #XXX".
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

  const salutation = buildSalutation(contact);
  const programmeEntry = findProgramme(programName);
  const accroche = (programmeEntry && programmeEntry.accroche) || '';

  // Gate fenêtre horaire (règle Norman 2026-05-18) — pas d'envoi hors 9h-20h
  // Paris ni le dimanche. Skip sans incrémenter counter → re-tenté demain.
  if (!isWithinAllowedSendHours()) {
    return { skipped: true, reason: 'hors fenêtre 9h-20h Paris (ou dimanche)' };
  }

  // Determine channel + content selon le jour. Pattern E/W/E.
  let channel, subject = null, html = null, whatsappTo = null;
  if (dayNumber === 1) {
    channel = 'email';
    ({ subject, html } = buildJ15Day1Email(salutation, programName, accroche));
  } else if (dayNumber === 2) {
    if (CONFIG.WHATSAPP_J15_ENABLED && CONFIG.TWILIO_TEMPLATE_J16) {
      channel = 'whatsapp';
      whatsappTo = normalizePhoneE164(contact.phone || record.whatsappTo);
    } else {
      // Fallback email si template Meta J+16 pas dispo (ou WhatsApp J+15 désactivé).
      channel = 'email-fallback';
      ({ subject, html } = buildJ15Day2Fallback(salutation, programName, accroche));
    }
  } else { // dayNumber === 3
    channel = 'email';
    ({ subject, html } = buildJ15Day3Email(salutation, programName, accroche));
  }

  // GATE — dry-run ou kill switch → return without sending (cf incident 2026-05-15).
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
    try { await sendEmailViaPowerAutomate(email, subject, html); }
    catch (e) { emailError = e.message; }
    if (!emailError) {
      try {
        await createAdleadRecord(record.programId, record.leadId, 'email', 'Email envoyé');
      } catch (e) { console.log(`[j15] (info) record Adlead échec lead ${record.leadId}: ${e.message.slice(0, 120)}`); }
    }
  } else if (channel === 'whatsapp') {
    if (whatsappTo) {
      try {
        const _j16BrochureUrl = getBrochureUrl(programName);
        const r = await sendWhatsAppViaTwilio(whatsappTo, '', {
          templateSid: CONFIG.TWILIO_TEMPLATE_J16,
          contentVariables: { '1': firstName, '2': programName, ...(_j16BrochureUrl ? { '3': _j16BrochureUrl } : {}) },
        });
        whatsappSid = r?.sid || null;
      } catch (e) { whatsappError = e.message; }
      if (!whatsappError) {
        try {
          await createAdleadRecord(record.programId, record.leadId, 'sms', 'WhatsApp envoyé');
        } catch (e) { console.log(`[j15] (info) record Adlead WA échec lead ${record.leadId}: ${e.message.slice(0, 120)}`); }
      }
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
        // CRITIQUE : on n'incrémente le counter QUE si on a vraiment envoyé.
        // sendDisabled est un kill switch qui doit se comporter comme dryRun
        // pour l'état (pas de mutation). Sinon le cron en mode "Phase A safe"
        // fait avancer les compteurs sans envoyer → à la fin tous les leads
        // sont "max=3" et plus rien ne part quand on flip sendDisabled=false.
        if (result.sent && !dryRun && !result.sendDisabled) {
          record.j15Relances = (record.j15Relances || 0) + 1;
          record.j15History = record.j15History || [];
          record.j15History.push({
            day: result.dayNumber,
            channel: result.channel,
            sentAt: new Date().toISOString(),
            email: result.email,
            subject: result.subject,
            emailError: result.emailError || null,
            whatsappSid: result.whatsappSid || null,
            whatsappError: result.whatsappError || null,
          });
          saveProcessed();
        } else if (result.reset && !dryRun) {
          saveProcessed(); // reset du counter → persist
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
      const skipReasons = {};
      for (const r of results) {
        if (r.skipped && r.reason) {
          const key = String(r.reason).slice(0, 60);
          skipReasons[key] = (skipReasons[key] || 0) + 1;
        }
      }
      lastJ15RunReport = {
        ymd: new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0, 10),
        completedAt: new Date().toISOString(),
        scanned: candidates.length,
        sent: sentCount,
        skipped: skipCount,
        errors: errCount,
        skipReasons,
      };
    }
    return { dryRun, candidates: candidates.length, results };
  } finally {
    j15TickRunning = false;
  }
}

let lastJ15RunYmd = null;
let lastJ15RunReport = null; // rapport de la dernière exéc réelle (pas dry-run)
// ─── HELPERS FENÊTRE HORAIRE PARIS (règle Norman 2026-05-18) ───────────────
// Pas d'envoi prospect en dehors de 9h-20h Paris. Dimanche entier exclu.
// `testNow` (optionnel) permet de mocker l'heure pour les tests unitaires.

function isWithinAllowedSendHours(testNow) {
  const now = testNow
    || (process.env.TEST_FORCE_NOW_ISO ? new Date(process.env.TEST_FORCE_NOW_ISO) : new Date());
  // toLocaleString avec timeZone donne l'heure Paris ; on la re-parse pour
  // extraire jour de la semaine + heure de manière déterministe.
  const parisStr = now.toLocaleString('en-US', { timeZone: 'Europe/Paris' });
  const parisDate = new Date(parisStr);
  const day = parisDate.getDay();      // 0 = dimanche
  const hour = parisDate.getHours();
  if (day === 0) return false;          // dimanche : blocage toute la journée
  return hour >= CONFIG.SEND_HOUR_START_PARIS && hour < CONFIG.SEND_HOUR_END_PARIS;
}

// Calcule la prochaine date/heure valide pour envoi (utile pour reporter
// le checkAt d'un lead en queue qu'on n'a pas pu traiter à cause de la fenêtre).
function computeNextAllowedSendTime(testNow) {
  const now = testNow || new Date();
  const parisStr = now.toLocaleString('en-US', { timeZone: 'Europe/Paris' });
  let parisDate = new Date(parisStr);
  const startH = CONFIG.SEND_HOUR_START_PARIS;
  const endH = CONFIG.SEND_HOUR_END_PARIS;
  // Si on est avant 9h aujourd'hui (et pas dimanche) → setter à 9h aujourd'hui.
  // Si on est après 20h ou dimanche → setter à 9h le prochain jour valide.
  if (parisDate.getDay() !== 0 && parisDate.getHours() < startH) {
    parisDate.setHours(startH, 0, 0, 0);
  } else {
    // Avance d'un jour
    parisDate.setDate(parisDate.getDate() + 1);
    parisDate.setHours(startH, 0, 0, 0);
    // Si on tombe sur dimanche → encore +1 jour
    while (parisDate.getDay() === 0) {
      parisDate.setDate(parisDate.getDate() + 1);
    }
  }
  // parisDate est dans le fuseau local du process. On veut le ramener en UTC.
  // Hack : on calcule l'offset Paris au moment courant et on l'applique.
  const offsetMs = parisDate.getTime() - new Date(parisDate.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  return new Date(parisDate.getTime() - offsetMs);
}

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
  if (CONFIG.PIPELINE_DISABLED) return;
  const { ymd, hour } = getParisYmdAndHour();
  if (hour < CONFIG.J15_CRON_HOUR_PARIS) return; // trop tôt
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
  if (record.status !== 'sent') return false;
  const refMs = new Date(record.processedAt || 0).getTime();
  if (!refMs) return false;
  const ageDays = (now - refMs) / (1000 * 60 * 60 * 24);
  const n = record.j3mRelances || 0;
  // Fenêtre ouverte : >= seuil + < 14j (pas de chevauchement avec J+15).
  // Pas de fenêtre stricte d'1 jour : si le cron saute, le lead est rattrapé le lendemain.
  const todayYmd = new Date().toISOString().slice(0, 10);
  if (record.j3mRetryAfter && todayYmd >= record.j3mRetryAfter && n < 3) return true;
  if (n === 0 && ageDays >= 3 && ageDays < 14) return true;
  if (n === 1 && ageDays >= 4 && ageDays < 14) return true;
  if (n === 2 && ageDays >= 5 && ageDays < 14) return true;
  return false;
}

function buildFullSignature() {
  return `<p style="margin-top: 24px; font-size: 13px; line-height: 1.5;">
<strong>Norman DADON</strong><br>
Directeur des ventes<br>
<strong>Catella Residential</strong><br>
4 rue de Lasteyrie<br>
75116 Paris<br>
<span style="color:#888;">-----------------------------------------------------------------</span><br>
Tel: +33 (0)1 56 79 79 79<br>
Mobile: +33 (0)6 64 58 24 11<br>
E-mail: <a href="mailto:Norman.Dadon@catella.fr">Norman.Dadon@catella.fr</a><br>
Web: <a href="https://www.catellaresidential.fr">www.catellaresidential.fr</a> | <a href="https://www.catella.com">www.catella.com</a>
</p>`;
}

function buildJ3MEmailDay1(salutation, programName, accroche) {
  const subject = `Petit point sur votre demande ${programName}`;
  const html = `<p>Bonjour ${salutation},</p>
<p>Petit point rapide concernant votre demande pour ${programName}. Je n'ai pas encore eu votre retour suite à mes premiers messages, et je préférais m'assurer que vous les avez bien reçus.</p>
${accroche ? `<p><em>${escapeHtml(accroche)}</em></p>` : ''}
<p>Avez-vous quelques minutes pour qu'on échange brièvement de votre projet ? Répondez directement à ce mail, je vous rappelle dans la journée.</p>
<p>Au plaisir d'échanger,</p>
${buildFullSignature()}`;
  return { subject, html };
}

function buildJ3MEmailDay2Fallback(salutation, programName, accroche) {
  const subject = `${programName} — disponibilités à étudier`;
  const html = `<p>Bonjour ${salutation},</p>
<p>Je reviens vers vous concernant votre demande sur ${programName}.</p>
${accroche ? `<p><em>${escapeHtml(accroche)}</em></p>` : ''}
<p>Je viens de regarder le programme : nous avons encore des disponibilités. Si votre projet est toujours d'actualité, c'est le moment d'en discuter. N'hésitez pas à me donner vos critères d'acquisition en réponse à ce mail.</p>
${buildFullSignature()}`;
  return { subject, html };
}

function buildJ3MEmailDay3(salutation, programName, accroche) {
  const subject = `${programName} — dernier point avant de classer votre dossier`;
  const html = `<p>Bonjour ${salutation},</p>
<p>Dernier message de ma part concernant ${programName}.</p>
${accroche ? `<p><em>${escapeHtml(accroche)}</em></p>` : ''}
<p>Sans nouvelles, je vais classer votre dossier en fin de semaine. Si votre projet immobilier est toujours d'actualité, c'est vraiment le moment de me le faire savoir — répondez directement à ce mail avec vos critères, je vous envoie immédiatement les plans et les prix disponibles.</p>
<p>Je reste à votre disposition,</p>
${buildFullSignature()}`;
  return { subject, html };
}

async function processJ3MCandidate(record, { dryRun = false, sendDisabled = false } = {}) {
  const lead = await fetchLead(record.leadId, { programId: record.programId });
  if (!lead) return { skipped: true, reason: 'lead introuvable côté Adlead' };

  // Safety : dénonciation bloque toujours (consistant avec J+1 et J+15).
  if (lead.is_under_prescription === true) {
    return { skipped: true, reason: 'is_under_prescription=true' };
  }
  if (lead.discard_reason != null) {
    return { skipped: true, reason: `discard_reason="${lead.discard_reason}"` };
  }

  // Status check — règle Option A : si status ≠ pending, on reset le counter
  // (cycle stoppé) et on skip. Si status revient à pending plus tard, le cycle
  // recommence depuis #1 (frais).
  if (lead.status !== 'pending') {
    let reset = false;
    if ((record.j3mRelances || 0) > 0) {
      if (!dryRun) record.j3mRelances = 0;
      reset = true;
    }
    return { skipped: true, reason: `lead.status="${lead.status}" (≠ pending)`, reset };
  }

  // Référence = date d'envoi J+1 (record.processedAt), pas last_interaction_at.
  // Raison : last_interaction_at est mis à jour à chaque action commerciale (appel, note…),
  // ce qui réinitialiserait le compteur 3 jours et retarderait indéfiniment J+3.
  // Cadence J+3 / J+4 / J+5 depuis processedAt :
  //   counter=0 + ageDays >= 3 → send #1 (email doux)
  //   counter=1 + ageDays >= 4 → send #2 (WhatsApp ou email)
  //   counter=2 + ageDays >= 5 → send #3 (email final)
  const j3mRefDate = record.processedAt;
  if (!j3mRefDate) {
    return { skipped: true, reason: 'processedAt null' };
  }
  const daysSinceLastAction = (Date.now() - new Date(j3mRefDate).getTime()) / (1000 * 60 * 60 * 24);
  const currentCount = record.j3mRelances || 0;
  const j3mThresholds = [3, 4, 5];
  const j3mThreshold = j3mThresholds[currentCount] ?? 99;
  let dayNumber;
  if (currentCount === 0 && daysSinceLastAction >= 3) dayNumber = 1;
  else if (currentCount === 1 && daysSinceLastAction >= 4) dayNumber = 2;
  else if (currentCount === 2 && daysSinceLastAction >= 5) dayNumber = 3;
  else {
    const daysLeft = j3mThreshold - daysSinceLastAction;
    const retryDate = new Date(Date.now() + daysLeft * 86400000).toISOString().slice(0, 10);
    if (!record.j3mRetryAfter || retryDate < record.j3mRetryAfter) {
      record.j3mRetryAfter = retryDate;
    }
    return {
      skipped: true,
      reason: `pas de relance prévue (j3mRelances=${currentCount}, daysSinceAction=${daysSinceLastAction.toFixed(1)}, retryAfter=${record.j3mRetryAfter})`,
    };
  }
  record.j3mRetryAfter = null;

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

  const salutation = buildSalutation(contact);
  const programmeEntry = findProgramme(programName);
  const accroche = (programmeEntry && programmeEntry.accroche) || '';

  // Gate fenêtre horaire (règle Norman 2026-05-18) — pas d'envoi hors 9h-20h
  // Paris ni le dimanche. Skip sans incrémenter counter → re-tenté demain.
  if (!isWithinAllowedSendHours()) {
    return { skipped: true, reason: 'hors fenêtre 9h-20h Paris (ou dimanche)' };
  }

  // Determine channel + content pour ce jour.
  let channel, subject = null, html = null, whatsappTo = null;
  if (dayNumber === 1) {
    channel = 'email';
    ({ subject, html } = buildJ3MEmailDay1(salutation, programName, accroche));
  } else if (dayNumber === 2) {
    if (CONFIG.WHATSAPP_J3M_ENABLED && CONFIG.TWILIO_TEMPLATE_J3M_DAY2) {
      channel = 'whatsapp';
      whatsappTo = normalizePhoneE164(contact.phone || record.whatsappTo);
    } else {
      // Fallback email pour ne pas casser le cycle d'escalation.
      channel = 'email-fallback';
      ({ subject, html } = buildJ3MEmailDay2Fallback(salutation, programName, accroche));
    }
  } else { // dayNumber === 3
    channel = 'email';
    ({ subject, html } = buildJ3MEmailDay3(salutation, programName, accroche));
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
    if (!emailError) {
      try {
        await createAdleadRecord(record.programId, record.leadId, 'email', 'Email envoyé');
      } catch (e) { console.log(`[j3m] (info) record Adlead échec lead ${record.leadId}: ${e.message.slice(0, 120)}`); }
    }
  } else if (channel === 'whatsapp') {
    if (whatsappTo) {
      try {
        const _j3mBrochureUrl = getBrochureUrl(programName);
        const r = await sendWhatsAppViaTwilio(whatsappTo, '', {
          templateSid: CONFIG.TWILIO_TEMPLATE_J3M_DAY2,
          contentVariables: { '1': firstName, '2': programName, ...(_j3mBrochureUrl ? { '3': _j3mBrochureUrl } : {}) },
        });
        whatsappSid = r?.sid || null;
      } catch (e) { whatsappError = e.message; }
      if (!whatsappError) {
        try {
          await createAdleadRecord(record.programId, record.leadId, 'sms', 'WhatsApp envoyé');
        } catch (e) { console.log(`[j3m] (info) record Adlead WA échec lead ${record.leadId}: ${e.message.slice(0, 120)}`); }
      }
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
          // CRITIQUE : on n'incrémente le counter QUE si on a vraiment envoyé.
          // sendDisabled doit se comporter comme dryRun pour l'état sinon
          // les counters avancent sans envoi → max=3 → plus rien ne part.
          if (result.sent && !result.sendDisabled) {
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
          } else if (result.reset) {
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
      // Agrège les raisons de skip pour le rapport
      const skipReasons = {};
      for (const r of results) {
        if (r.skipped && r.reason) {
          const key = String(r.reason).slice(0, 60);
          skipReasons[key] = (skipReasons[key] || 0) + 1;
        }
      }
      lastJ3MRunReport = {
        ymd: new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0, 10),
        completedAt: new Date().toISOString(),
        scanned: candidates.length,
        sent: sentCount,
        skipped: skipCount,
        errors: errCount,
        skipReasons,
      };
    }
    return { dryRun, candidates: candidates.length, results };
  } finally {
    j3mTickRunning = false;
  }
}

let lastJ3MRunYmd = null;
let lastJ3MRunReport = null; // rapport de la dernière exéc réelle (pas dry-run)
async function j3mCron() {
  if (CONFIG.PIPELINE_DISABLED) return;
  const { ymd, hour, minute } = getParisYmdHourMinute();
  if (hour < CONFIG.J3M_CRON_HOUR_PARIS) return; // trop tôt
  if (hour === CONFIG.J3M_CRON_HOUR_PARIS && minute < CONFIG.J3M_CRON_MIN_MINUTE) return;
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

// ─── SLACK NOTIFICATIONS ────────────────────────────────────────────────────
async function sendSlackNotification(blocks) {
  if (!CONFIG.SLACK_WEBHOOK_URL) {
    console.warn('[slack] SLACK_WEBHOOK_URL non configuré — notification ignorée');
    return false;
  }
  try {
    const r = await fetch(CONFIG.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`);
    return true;
  } catch (e) {
    console.error('[slack] envoi échoué:', e.message);
    return false;
  }
}

// ─── DAILY HEALTH CHECK ─────────────────────────────────────────────────────
// Vérifie chaque jour :
//   1. Connexion Twilio (credentials valides)
//   2. Webhook entrant configuré sur le numéro WhatsApp (URL correcte)
//   3. Activité : réponses prospects reçues aujourd'hui + hier via Twilio
//   4. Stats pipeline local : leads traités + en attente
// Résultat envoyé sur Slack à 8h30 Paris.
async function runDailyHealthCheck() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: 'long', year: 'numeric' });
  const checks = {};
  const issues = [];

  // ── 1. Twilio API connectivity + webhook URL check ─────────────────────────
  if (CONFIG.TWILIO_ACCOUNT_SID && CONFIG.TWILIO_AUTH_TOKEN) {
    try {
      const auth = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PageSize=20`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const numbers = data.incoming_phone_numbers || [];
      const ourRaw = (CONFIG.TWILIO_WHATSAPP_FROM || '').replace(/^whatsapp:/, '').trim();
      const ourNum = numbers.find(n => n.phone_number === ourRaw || n.phone_number.replace(/\D/g, '') === ourRaw.replace(/\D/g, ''));
      const expectedWebhook = `${CONFIG.TWILIO_WEBHOOK_BASE_URL}/webhook/whatsapp-incoming`;

      checks.twilioApi = '✅ connecté';

      if (ourNum) {
        const configured = ourNum.sms_url || '';
        if (configured === expectedWebhook) {
          checks.webhookUrl = `✅ configuré (${configured})`;
        } else if (configured) {
          checks.webhookUrl = `⚠️ URL différente de celle attendue\n  • Actuelle : ${configured}\n  • Attendue : ${expectedWebhook}`;
          issues.push('webhook URL différente de celle attendue');
        } else {
          checks.webhookUrl = `❌ aucun webhook configuré sur ${ourRaw}`;
          issues.push('webhook entrant WhatsApp non configuré sur Twilio');
        }
      } else {
        checks.webhookUrl = `⚠️ numéro ${ourRaw} introuvable dans les IncomingPhoneNumbers`;
        issues.push('numéro WhatsApp introuvable dans Twilio — peut être un sender séparé');
      }
    } catch (e) {
      checks.twilioApi = `❌ erreur : ${e.message}`;
      checks.webhookUrl = '❌ non vérifié (connexion Twilio échouée)';
      issues.push(`Twilio API inaccessible : ${e.message}`);
    }
  } else {
    checks.twilioApi = '❌ credentials non configurés (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN manquants)';
    checks.webhookUrl = '❌ non vérifié';
    issues.push('Twilio non configuré');
  }

  // ── 2. Messages inbound reçus aujourd'hui et hier (via Twilio API) ──────────
  try {
    const auth = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');
    const todayParis = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); // "2026-05-25"
    const url = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json?To=${encodeURIComponent(CONFIG.TWILIO_WHATSAPP_FROM)}&PageSize=100`;
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (r.ok) {
      const data = await r.json();
      const inbound = (data.messages || []).filter(m => m.direction === 'inbound');
      const todayInbound = inbound.filter(m => (m.date_sent || m.date_created || '').startsWith(todayParis));
      checks.inboundToday = todayInbound.length > 0
        ? `✅ ${todayInbound.length} réponse(s) prospects reçue(s) aujourd'hui`
        : `ℹ️ 0 réponse reçue aujourd'hui (normal si pas d'envoi la nuit)`;
    } else {
      checks.inboundToday = `⚠️ impossible de vérifier (HTTP ${r.status})`;
    }
  } catch (e) {
    checks.inboundToday = `⚠️ erreur fetch Twilio : ${e.message}`;
  }

  // ── 3. Stats pipeline local ────────────────────────────────────────────────
  const todayParis = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
  const processedToday = processedLeads.filter(l =>
    l.status === 'sent' && (l.processedAt || '').startsWith(todayParis)
  ).length;
  const repliesInApp = processedLeads.filter(l =>
    l.status === 'whatsapp_reply_received' && (l.receivedAt || l.processedAt || '').startsWith(todayParis)
  ).length;
  const pendingCount = pendingLeads.length;

  checks.pipelineStats = `📤 Leads traités aujourd'hui : ${processedToday} | ⏳ En attente : ${pendingCount} | 💬 Réponses enregistrées : ${repliesInApp}`;

  // ── 4. Construction du message Slack ───────────────────────────────────────
  const allGood = issues.length === 0;
  const statusEmoji = allGood ? '✅' : '⚠️';
  const statusText  = allGood ? 'Tout fonctionne aujourd\'hui' : `${issues.length} problème(s) détecté(s)`;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${statusEmoji} Pipeline Catella — ${statusText}`, emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Rapport automatique du *${dateStr}* · lead-automation Railway` }],
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Twilio API*\n${checks.twilioApi}` },
        { type: 'mrkdwn', text: `*Webhook entrant WhatsApp*\n${checks.webhookUrl}` },
        { type: 'mrkdwn', text: `*Messages inbound Twilio*\n${checks.inboundToday}` },
        { type: 'mrkdwn', text: `*Pipeline*\n${checks.pipelineStats}` },
      ],
    },
  ];

  if (!allGood) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🚨 Problèmes à corriger :*\n${issues.map(i => `• ${i}`).join('\n')}`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `<https://lead-automation-production-33e8.up.railway.app|🔗 Ouvrir le dashboard>`,
    }],
  });

  const slackOk = await sendSlackNotification(blocks);
  console.log(`[daily-health] ${statusText} — Slack: ${slackOk ? 'envoyé' : 'échec/désactivé'} — issues: [${issues.join(', ') || 'aucun'}]`);
  return { allGood, issues, checks };
}

// Endpoint on-demand pour tester le health check immédiatement.
app.post('/api/admin/daily-health-check', async (req, res) => {
  try {
    const result = await runDailyHealthCheck();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cron quotidien 8h30 Paris — même pattern que j15Cron / j3mCron.
let healthCheckLastRun = null;
async function dailyHealthCheckCron() {
  const nowParis = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  const [h, m] = nowParis.split(':').map(Number);
  if (h !== 8 || m < 30 || m > 34) return; // fenêtre 8h30-8h34 (tick toutes les 5 min)
  const todayKey = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
  if (healthCheckLastRun === todayKey) return; // déjà tourné aujourd'hui
  healthCheckLastRun = todayKey;
  console.log('[daily-health] lancement du health check quotidien 8h30 Paris');
  await runDailyHealthCheck().catch(e => console.error('[daily-health] erreur:', e.message));
}
setInterval(dailyHealthCheckCron, 5 * 60 * 1000);

// ─── DIGEST TOUTES LES 3H ────────────────────────────────────────────────────
// Envoie un email récapitulatif à Norman à 9h, 12h, 15h et 18h Paris.
// Résumé des 3 dernières heures : J+1 envoyés, annulés, réponses WA, J+3/J+15.

let digestLastRunKey = null; // "YYYY-MM-DD-HH" pour éviter les doublons

async function sendActivityDigest(windowHours = 3) {
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const since = now - windowMs;

  const recent = processedLeads.filter(l => new Date(l.processedAt || l.receivedAt || 0).getTime() >= since);

  const sent      = recent.filter(l => l.status === 'sent');
  const cancelled = recent.filter(l => l.status === 'cancelled');
  const errors    = recent.filter(l => l.status === 'error');
  const waReplies = recent.filter(l => l.status === 'whatsapp_reply_received');
  const waSent    = recent.filter(l => l.status === 'whatsapp_reply_sent');

  const pending = pendingLeads.length;

  const timeStr = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  const subject = `[Catella Pipeline] Bilan ${timeStr} — ${sent.length} envoyé${sent.length !== 1 ? 's' : ''} · ${waReplies.length} réponse${waReplies.length !== 1 ? 's' : ''} WA`;

  const fmtDate = iso => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

  const rowStyle = 'padding:6px 10px;border-bottom:1px solid #f0f0f0;';
  const thStyle  = 'padding:6px 10px;background:#f5f5f7;font-weight:600;text-align:left;font-size:12px;color:#555;';

  const sentRows = sent.length ? sent.map(l => `
    <tr>
      <td style="${rowStyle}">${fmtDate(l.processedAt)}</td>
      <td style="${rowStyle}">${escapeHtml(l.programName || '—')}</td>
      <td style="${rowStyle}">${(l.email || '').replace(/(.{2}).*(@.*)/, '$1***$2') || '—'}</td>
      <td style="${rowStyle}">${l.whatsappSid ? '✅ WA' : '—'}</td>
    </tr>`).join('') : `<tr><td colspan="4" style="${rowStyle}color:#aaa;">Aucun envoi</td></tr>`;

  const cancelRows = cancelled.length ? cancelled.slice(0, 10).map(l => `
    <tr>
      <td style="${rowStyle}">${fmtDate(l.processedAt)}</td>
      <td style="${rowStyle}">${escapeHtml(l.programName || `#${l.programId}` || '—')}</td>
      <td style="${rowStyle}color:#888;font-size:12px;">${escapeHtml((l.reason || '').slice(0, 80))}</td>
    </tr>`).join('') + (cancelled.length > 10 ? `<tr><td colspan="3" style="${rowStyle}color:#aaa;">… et ${cancelled.length - 10} autres</td></tr>` : '')
    : `<tr><td colspan="3" style="${rowStyle}color:#aaa;">Aucun</td></tr>`;

  const waRows = waReplies.length ? waReplies.map(l => `
    <tr>
      <td style="${rowStyle}">${fmtDate(l.receivedAt || l.processedAt)}</td>
      <td style="${rowStyle}font-weight:600;">${escapeHtml(l.contactName || l.whatsappProfileName || l.whatsappFrom || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(l.programName || '—')}</td>
      <td style="${rowStyle}font-size:12px;color:#444;">${escapeHtml((l.whatsappBody || '').slice(0, 80))}${(l.whatsappBody || '').length > 80 ? '…' : ''}</td>
    </tr>`).join('')
    : `<tr><td colspan="4" style="${rowStyle}color:#aaa;">Aucune réponse</td></tr>`;

  const j3mInfo  = lastJ3MRunReport  ? `J+3 : ${lastJ3MRunReport.sent || 0} envoyé(s), ${lastJ3MRunReport.skipped || 0} skippé(s) — run du ${lastJ3MRunReport.ymd}` : 'J+3 : pas de run récent';
  const j15Info  = lastJ15RunReport  ? `J+15 : ${lastJ15RunReport.sent || 0} envoyé(s), ${lastJ15RunReport.skipped || 0} skippé(s) — run du ${lastJ15RunReport.ymd}` : 'J+15 : pas de run récent';

  const kpiBar = (label, val, color) =>
    `<td style="padding:12px 20px;text-align:center;"><div style="font-size:28px;font-weight:700;color:${color};">${val}</div><div style="font-size:11px;color:#888;margin-top:2px;">${label}</div></td>`;

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1d1d1f;background:#f5f5f7;margin:0;padding:20px;">
<div style="max-width:640px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.08);">

  <div style="background:#1a3a5c;padding:20px 24px;">
    <div style="color:white;font-size:18px;font-weight:700;">📊 Bilan pipeline — ${timeStr} Paris</div>
    <div style="color:rgba(255,255,255,.7);font-size:13px;margin-top:4px;">Activité des ${windowHours} dernières heures · ${new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' })}</div>
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #f0f0f0;">
    <tr>
      ${kpiBar('Envoyés J+1', sent.length, sent.length > 0 ? '#25c281' : '#1d1d1f')}
      ${kpiBar('Annulés', cancelled.length, '#888')}
      ${kpiBar('Réponses WA', waReplies.length, waReplies.length > 0 ? '#f59e0b' : '#1d1d1f')}
      ${kpiBar('Erreurs', errors.length, errors.length > 0 ? '#ef4444' : '#1d1d1f')}
      ${kpiBar('En attente', pending, pending > 5 ? '#f59e0b' : '#1d1d1f')}
    </tr>
  </table>

  <div style="padding:20px 24px;">

    <h3 style="margin:0 0 10px;font-size:14px;color:#1a3a5c;">📤 Relances J+1 envoyées (${sent.length})</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <tr><th style="${thStyle}">Heure</th><th style="${thStyle}">Programme</th><th style="${thStyle}">Email</th><th style="${thStyle}">WA</th></tr>
      ${sentRows}
    </table>

    <h3 style="margin:0 0 10px;font-size:14px;color:#1a3a5c;">💬 Réponses WhatsApp reçues (${waReplies.length})</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <tr><th style="${thStyle}">Heure</th><th style="${thStyle}">Prospect</th><th style="${thStyle}">Programme</th><th style="${thStyle}">Message</th></tr>
      ${waRows}
    </table>

    <h3 style="margin:0 0 10px;font-size:14px;color:#1a3a5c;">🚫 Leads annulés (${cancelled.length})</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <tr><th style="${thStyle}">Heure</th><th style="${thStyle}">Programme</th><th style="${thStyle}">Raison</th></tr>
      ${cancelRows}
    </table>

    <div style="background:#f5f5f7;border-radius:8px;padding:12px 16px;font-size:13px;color:#555;">
      <strong>Relances automatiques :</strong><br/>
      ${j3mInfo}<br/>
      ${j15Info}
    </div>

  </div>

  <div style="padding:12px 24px;background:#f5f5f7;font-size:11px;color:#aaa;text-align:center;">
    Pipeline Catella Lead Automation · <a href="https://lead-automation-production-33e8.up.railway.app/" style="color:#0070f3;">Dashboard</a>
  </div>
</div>
</body></html>`;

  await sendEmailViaPowerAutomate(CONFIG.INTERNAL_NOTIF_EMAIL, subject, html);
  console.log(`[digest] ✅ bilan ${timeStr} envoyé (${sent.length} envoyés, ${waReplies.length} réponses WA, ${cancelled.length} annulés)`);
}

const DIGEST_HOURS = new Set([9, 12, 15, 18]);
async function digestCron() {
  if (CONFIG.PIPELINE_DISABLED) return;
  if (!CONFIG.POWER_AUTOMATE_URL) return;
  const { ymd, hour } = getParisYmdAndHour();
  if (!DIGEST_HOURS.has(hour)) return;
  const runKey = `${ymd}-${hour}`;
  if (digestLastRunKey === runKey) return;
  digestLastRunKey = runKey;
  try {
    await sendActivityDigest(3);
  } catch (e) {
    console.error('[digest] erreur envoi:', e.message);
  }
}
setInterval(digestCron, 5 * 60 * 1000);

// ─── AUTO-POLLING RÉPONSES WHATSAPP ─────────────────────────────────────────
// Fallback critique : si le webhook Twilio n'est pas configuré (ou tombe),
// ce polling récupère quand même toutes les réponses prospects toutes les heures.
// Aussi lancé au démarrage pour rattraper les messages manqués.
// Idempotent par SID — aucun doublon possible.
const WA_POLL_META_FILE = path.join(DATA_DIR, 'wa_poll_meta.json');

function loadWaPollMeta() {
  try { return JSON.parse(fs.readFileSync(WA_POLL_META_FILE, 'utf8')); } catch { return {}; }
}
function saveWaPollMeta(meta) {
  saveJsonFile(WA_POLL_META_FILE, meta);
}

async function pollWhatsAppReplies() {
  if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN) return;
  const meta = loadWaPollMeta();
  const now = new Date();
  console.log('[wa-poll] démarrage polling réponses WhatsApp entrants…');

  const auth = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');
  const existingSids = new Set(
    processedLeads.filter(l => l.whatsappMessageSid).map(l => l.whatsappMessageSid)
  );
  const normalizeForMatch = (s) => String(s || '').replace(/[^\d+]/g, '');

  // Date de début : dernière exécution ou 90 jours en arrière (premier lancement)
  const since = meta.lastPollAt
    ? new Date(new Date(meta.lastPollAt).getTime() - 60 * 60 * 1000).toISOString().slice(0, 10) // overlap 1h
    : new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let allMessages = [];
  const params = new URLSearchParams({ PageSize: '100' });
  params.append('DateSent>', since);
  let nextPageUrl = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json?${params.toString()}`;
  let pageCount = 0;

  try {
    while (nextPageUrl && pageCount < 30) {
      const r = await fetch(nextPageUrl, { headers: { Authorization: `Basic ${auth}` } });
      if (!r.ok) { console.error(`[wa-poll] Twilio API ${r.status}`); break; }
      const data = await r.json();
      const inbound = (data.messages || []).filter(m =>
        m.direction === 'inbound' &&
        (String(m.from || '').startsWith('whatsapp:') || String(m.to || '').startsWith('whatsapp:'))
      );
      allMessages = allMessages.concat(inbound);
      nextPageUrl = data.next_page_uri ? `https://api.twilio.com${data.next_page_uri}` : null;
      pageCount++;
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  } catch (e) {
    console.error('[wa-poll] erreur fetch Twilio:', e.message);
    return;
  }

  let inserted = 0;
  const newRecords = [];
  for (const msg of allMessages) {
    const msgSid = msg.sid;
    if (existingSids.has(msgSid)) continue;
    const fromRaw  = String(msg.from || '');
    const fromE164 = fromRaw.replace(/^whatsapp:/, '').trim();
    const body     = String(msg.body || '').trim();
    const receivedAt = msg.date_sent || msg.date_created || now.toISOString();
    const fromNorm = normalizeForMatch(fromE164);

    let match = null;
    for (let i = processedLeads.length - 1; i >= 0; i--) {
      const l = processedLeads[i];
      if (l.status !== 'sent' || !l.whatsappTo) continue;
      if (normalizeForMatch(l.whatsappTo) === fromNorm) { match = l; break; }
    }

    const record = {
      id: `wa-reply-poll-${msgSid}`,
      status: 'whatsapp_reply_received',
      leadId:             match ? match.leadId      : null,
      programId:          match ? match.programId   : null,
      programName:        match ? match.programName : null,
      contactName:        match ? match.contactName : null,
      whatsappFrom:       fromE164,
      whatsappBody:       body,
      whatsappMessageSid: msgSid,
      whatsappProfileName: null,
      relatedSentId:      match ? match.id : null,
      matched:            !!match,
      receivedAt,
      processedAt:        now.toISOString(),
      backfilled:         true,
    };
    processedLeads.push(record);
    newRecords.push(record);
    existingSids.add(msgSid);
    inserted++;
  }

  if (inserted > 0) {
    saveProcessed();
    console.log(`[wa-poll] ✅ ${inserted} nouvelles réponses WA injectées (${allMessages.length} scannées, ${pageCount} pages)`);
  } else {
    console.log(`[wa-poll] ✓ ${allMessages.length} messages scannés — rien de nouveau`);
  }

  meta.lastPollAt = now.toISOString();
  meta.lastInserted = inserted;
  saveWaPollMeta(meta);
}

// Lancement immédiat au démarrage (après 5s pour laisser le serveur s'initialiser)
setTimeout(() => pollWhatsAppReplies().catch(e => console.error('[wa-poll] erreur démarrage:', e.message)), 5000);
// Puis toutes les 5 minutes
setInterval(() => pollWhatsAppReplies().catch(e => console.error('[wa-poll] erreur interval:', e.message)), 5 * 60 * 1000);

// ─── BACKUP QUOTIDIEN processed_leads.json ──────────────────────────────────
// Copie datée dans /data/processed_leads_backup_YYYY-MM-DD.json, garde 7 jours.
// Protection contre la perte de données au redémarrage Railway.
async function backupProcessed() {
  try {
    if (!fs.existsSync(PROCESSED_FILE)) return;
    const date = new Date().toISOString().slice(0, 10);
    const backupFile = path.join(DATA_DIR, `processed_leads_backup_${date}.json`);
    if (!fs.existsSync(backupFile)) {
      fs.copyFileSync(PROCESSED_FILE, backupFile);
      console.log(`[backup] processed_leads → ${backupFile} (${fs.statSync(backupFile).size} bytes)`);
    }
    // Rotation : garder max 7 backups
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => /^processed_leads_backup_\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    while (files.length > 7) {
      const old = files.shift();
      fs.unlinkSync(path.join(DATA_DIR, old));
      console.log(`[backup] supprimé ancien backup: ${old}`);
    }
  } catch (e) {
    console.error('[backup] erreur:', e.message);
  }
}
// Backup immédiat au démarrage (au cas où le serveur redémarre)
setTimeout(() => backupProcessed().catch(() => {}), 10 * 1000);
// Puis toutes les 24h
setInterval(() => backupProcessed().catch(() => {}), 24 * 60 * 60 * 1000);

// ─── ALERTE FENÊTRE WA SUR LE POINT D'EXPIRER ───────────────────────────────
// Toutes les 5 min : détecte les conversations où le prospect a répondu
// il y a 20h (fenêtre de 24h Meta → expire dans ~4h) sans réponse de Norman.
// Envoie une alerte WhatsApp sur son numéro perso.

const waWindowAlertSent = new Set(); // clé = phone+date pour éviter les répétitions

async function waWindowExpiryAlert() {
  if (!CONFIG.WHATSAPP_ENABLED) return;

  const now = Date.now();
  const H20 = 20 * 60 * 60 * 1000; // 20h = fenêtre à 4h de fermeture
  const H24 = 24 * 60 * 60 * 1000;

  // Reconstitue les conversations
  const convMap = {};
  for (const l of processedLeads) {
    let phone = null, direction = null;
    if (l.status === 'sent' && l.whatsappSid && l.whatsappTo) { phone = l.whatsappTo; direction = 'out'; }
    else if (l.status === 'whatsapp_reply_received' && l.whatsappFrom) { phone = l.whatsappFrom; direction = 'in'; }
    else if (l.status === 'whatsapp_reply_sent' && l.whatsappTo) { phone = l.whatsappTo; direction = 'out'; }
    if (!phone) continue;
    if (!convMap[phone]) convMap[phone] = { phone, contactName: null, programName: null, messages: [] };
    const c = convMap[phone];
    if (l.contactName && !c.contactName) c.contactName = l.contactName;
    if (l.programName && !c.programName) c.programName = l.programName;
    c.messages.push({ direction, time: l.processedAt || l.receivedAt || '' });
  }

  for (const c of Object.values(convMap)) {
    const sorted = c.messages.slice().sort((a, b) => new Date(a.time) - new Date(b.time));
    const lastMsg = sorted[sorted.length - 1];
    if (!lastMsg || lastMsg.direction !== 'in') continue; // pas de réponse prospect en attente

    const lastInAt = new Date(lastMsg.time).getTime();
    if (isNaN(lastInAt)) continue;
    const age = now - lastInAt;
    if (age < H20 || age >= H24) continue; // pas encore à 20h, ou déjà expirée

    // Alerte à envoyer — dédoublonnage : une seule alerte par conv par heure
    const alertKey = `${c.phone}-${Math.floor(age / (60 * 60 * 1000))}`;
    if (waWindowAlertSent.has(alertKey)) continue;
    waWindowAlertSent.add(alertKey);

    const name = c.contactName || c.phone;
    const prog = c.programName || '—';
    const remaining = Math.round((H24 - age) / (60 * 60 * 1000));
    const msg = `⏰ Fenêtre WA expire dans ${remaining}h\n${name} (${prog})\nRéponds avant fermeture !`;

    if (CONFIG.WHATSAPP_ENABLED && CONFIG.INTERNAL_NOTIF_PHONE) {
      sendWhatsAppViaTwilio(CONFIG.INTERNAL_NOTIF_PHONE, msg)
        .catch(e => console.error('[wa-expiry] WA erreur:', e.message));
    }
    console.log(`[wa-expiry] alerte envoyée — ${name} (${prog}), fenêtre expire dans ${remaining}h`);
  }
}
setInterval(() => waWindowExpiryAlert().catch(e => console.error('[wa-expiry] erreur:', e.message)), 5 * 60 * 1000);
