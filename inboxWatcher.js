// inboxWatcher.js ────────────────────────────────────────────────────────────
// Brique "Réponses prospect" du pipeline Lead Automation Catella.
//
// Workflow :
//   1. Quand server.js vient d'envoyer une relance J+1, il appelle
//      registerSentRelance() → on garde (leadId, programId, email, sujet, sentAt).
//   2. Un scheduler appelle poll() toutes les N minutes : il liste l'inbox Graph
//      depuis lastPoll, matche chaque message à une relance trackée, puis pour
//      chaque match appelle handleReply().
//   3. handleReply() :
//        a. classifyReply()  → Claude Sonnet 4.6 retourne une catégorie stricte
//        b. draftResponse()  → Claude rédige un brouillon HTML (ton Norman)
//        c. createDraftInOutlook() via Graph /me/messages/{id}/createReply
//        d. adleadPost sales-action "Réponse prospect — {catégorie}"
//
// Toutes les opérations sont en try/catch — si Claude ou Graph plantent, le
// pipeline de relance principal n'est JAMAIS impacté.
//
// Rate-limit : une conversation n'est pas retraitée si elle a déjà reçu
// MAX_REPLIES_PER_CONV_24H réponses dans les 24 dernières heures.
//
// Les brouillons ne partent JAMAIS tout seuls — ils se posent dans
// /Drafts d'Outlook et Norman les relit/édite/envoie.

const fs = require('fs');
const path = require('path');

let CONFIG = null;
let paths = null;
let helpers = null;

const state = {
  relances: [],     // tracking des relances envoyées
  replies: [],      // historique des réponses traitées
  lastPoll: null,   // ISO timestamp du dernier poll inbox
};

const MAX_REPLIES_PER_CONV_24H = 3;

// ─── INIT ──────────────────────────────────────────────────────────────────

function init({ config, dataDir, helpers: _helpers }) {
  CONFIG = config;
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    console.error(`[inboxWatcher] mkdir ${dataDir} échec: ${e.message}`);
  }
  paths = {
    relancesFile:   path.join(dataDir, 'relance_tracking.json'),
    repliesFile:    path.join(dataDir, 'replies_processed.json'),
    tokenCacheFile: path.join(dataDir, 'graph_token_cache.json'),
    pollStateFile:  path.join(dataDir, 'inbox_poll_state.json'),
  };
  helpers = _helpers || {};
  state.relances = loadJsonFile(paths.relancesFile, []);
  state.replies  = loadJsonFile(paths.repliesFile, []);
  const pollState = loadJsonFile(paths.pollStateFile, {});
  state.lastPoll = pollState.lastPoll || null;
  console.log(`[inboxWatcher] init — ${state.relances.length} relance(s) trackée(s), ${state.replies.length} réponse(s) traitée(s), lastPoll=${state.lastPoll || '(jamais)'}`);
}

function loadJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[inboxWatcher] Erreur lecture ${file}: ${e.message}`);
    return fallback;
  }
}

function saveJsonFile(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`[inboxWatcher] Erreur écriture ${file}: ${e.message}`);
  }
}

function saveRelances()  { saveJsonFile(paths.relancesFile, state.relances); }
function saveReplies()   { saveJsonFile(paths.repliesFile,  state.replies); }
function savePollState() { saveJsonFile(paths.pollStateFile, { lastPoll: state.lastPoll }); }

// ─── ENREGISTREMENT D'UNE RELANCE ENVOYÉE ──────────────────────────────────
// Appelé par server.js juste après un sendEmailViaPowerAutomate réussi.
// Si les creds Graph sont dispo, on tentera (best-effort) d'enrichir avec le
// conversationId et internetMessageId via une recherche dans /sentItems.
function registerSentRelance({ leadId, programId, contactEmail, contactName, programName, subject }) {
  if (!leadId || !contactEmail || !subject) {
    console.log(`[inboxWatcher] registerSentRelance skip — leadId=${leadId}, email=${contactEmail}`);
    return null;
  }
  const entry = {
    id:                `rel_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    leadId:            String(leadId),
    programId:         programId ? String(programId) : null,
    contactEmail:      String(contactEmail).toLowerCase(),
    contactName:       contactName || '',
    programName:       programName || '',
    subject,
    sentAt:            new Date().toISOString(),
    conversationId:    null,
    internetMessageId: null,
    repliesReceived:   0,
    lastReplyAt:       null,
  };
  state.relances.push(entry);
  // Rotation FIFO — on garde les 500 dernières relances pour limiter la taille disque
  if (state.relances.length > 500) state.relances = state.relances.slice(-500);
  saveRelances();
  console.log(`[inboxWatcher] relance trackée — lead ${leadId} → ${contactEmail}`);
  // Enrichissement best-effort en arrière-plan (pas bloquant pour le flow principal)
  if (hasGraphCreds()) {
    setTimeout(() => {
      enrichRelanceFromSentItems(entry).catch(e =>
        console.log(`[inboxWatcher] (info) enrich échec relance ${entry.id}: ${e.message}`));
    }, 15_000); // 15s pour laisser Outlook propager le message dans Sent Items
  }
  return entry;
}

async function enrichRelanceFromSentItems(entry) {
  // On cherche dans Sent Items un message récent avec le même destinataire et sujet.
  const sinceIso = new Date(new Date(entry.sentAt).getTime() - 2 * 60 * 1000).toISOString();
  const filter = `sentDateTime ge ${sinceIso}`;
  const qs = `$filter=${encodeURIComponent(filter)}&$top=20&$orderby=sentDateTime%20desc&$select=id,conversationId,internetMessageId,subject,toRecipients,sentDateTime`;
  const res = await graphFetch(`${graphMailboxPath()}/mailFolders/sentitems/messages?${qs}`);
  const msgs = Array.isArray(res?.value) ? res.value : [];
  for (const m of msgs) {
    const recipients = (m.toRecipients || []).map(r => (r.emailAddress?.address || '').toLowerCase());
    if (!recipients.includes(entry.contactEmail)) continue;
    if ((m.subject || '').trim() !== (entry.subject || '').trim()) continue;
    entry.conversationId    = m.conversationId || null;
    entry.internetMessageId = m.internetMessageId || null;
    saveRelances();
    console.log(`[inboxWatcher] enrich OK relance ${entry.id} — conv=${entry.conversationId}`);
    return;
  }
}

// ─── MICROSOFT GRAPH — AUTH VIA DEVICE CODE FLOW ──────────────────────────
// On utilise le public client ID Azure CLI (04b07795-8ddb-461a-bbee-02f9e1bf7b46)
// qui est universellement dispo et ne nécessite AUCUNE app registration côté tenant.
// L'admin-consent n'est pas requis pour Mail.Read/Mail.ReadWrite en delegated (si
// l'utilisateur a déjà consenti aux permissions Azure CLI — cas standard).
//
// Flow :
//   1. POST /common/oauth2/v2.0/devicecode → user_code + verification_uri + device_code
//   2. L'utilisateur va sur verification_uri, saisit user_code, approuve
//   3. Le serveur poll POST /common/oauth2/v2.0/token avec grant_type=device_code
//      jusqu'à obtenir access_token + refresh_token
//   4. On persiste tout ça dans ./data/graph-token.json
//   5. getGraphToken() refresh automatiquement avant expiration

const PUBLIC_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // Azure CLI (public client)
const GRAPH_SCOPES     = 'Mail.Read Mail.ReadWrite offline_access User.Read';
const TENANT           = 'common'; // pas besoin de connaître le tenant Catella

const DEVICECODE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`;
const TOKEN_URL      = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

// État global du device code flow en cours (un seul à la fois)
const deviceCodeState = {
  inProgress:       false,
  userCode:         null,
  verificationUri:  null,
  deviceCode:       null,
  expiresAt:        null,
  interval:         5,
  startedAt:        null,
  error:            null,
  completedAt:      null,
};

function hasGraphCreds() {
  // True si on a un refresh_token persisté sur disque → on peut getGraphToken().
  try {
    const data = JSON.parse(fs.readFileSync(paths.tokenCacheFile, 'utf8'));
    return !!data.refreshToken;
  } catch {
    return false;
  }
}

function loadTokenFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(paths.tokenCacheFile, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokenToDisk(tok) {
  saveJsonFile(paths.tokenCacheFile, tok);
}

let _cachedAccessToken = null; // { accessToken, expiresAt }

async function getGraphToken() {
  if (_cachedAccessToken && _cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return _cachedAccessToken.accessToken;
  }
  const stored = loadTokenFromDisk();
  if (!stored || !stored.refreshToken) {
    throw new Error('Aucun refresh_token Graph stocké — lance le device code flow via GET /api/auth/start');
  }
  // Si on a un access_token encore valide, reuse
  if (stored.accessToken && stored.accessExpiresAt && stored.accessExpiresAt > Date.now() + 60_000) {
    _cachedAccessToken = { accessToken: stored.accessToken, expiresAt: stored.accessExpiresAt };
    return stored.accessToken;
  }
  // Sinon refresh
  return refreshDelegatedToken(stored.refreshToken);
}

async function refreshDelegatedToken(refreshToken) {
  const params = new URLSearchParams();
  params.append('client_id',     PUBLIC_CLIENT_ID);
  params.append('refresh_token', refreshToken);
  params.append('grant_type',    'refresh_token');
  params.append('scope',         GRAPH_SCOPES);
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Graph token refresh ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  const accessExpiresAt = Date.now() + (Number(json.expires_in) - 30) * 1000;
  const updated = {
    refreshToken:    json.refresh_token || refreshToken, // Microsoft peut rotate le refresh
    accessToken:     json.access_token,
    accessExpiresAt,
    scope:           json.scope,
    updatedAt:       new Date().toISOString(),
    accountEmail:    loadTokenFromDisk()?.accountEmail || null,
  };
  saveTokenToDisk(updated);
  _cachedAccessToken = { accessToken: json.access_token, expiresAt: accessExpiresAt };
  return json.access_token;
}

// ─── DEVICE CODE FLOW — INITIATION ────────────────────────────────────────
async function startDeviceCodeFlow() {
  if (deviceCodeState.inProgress) {
    return {
      alreadyInProgress: true,
      userCode:          deviceCodeState.userCode,
      verificationUri:   deviceCodeState.verificationUri,
      expiresAt:         deviceCodeState.expiresAt,
    };
  }
  const params = new URLSearchParams();
  params.append('client_id', PUBLIC_CLIENT_ID);
  params.append('scope',     GRAPH_SCOPES);
  const res = await fetch(DEVICECODE_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`devicecode ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  deviceCodeState.inProgress      = true;
  deviceCodeState.userCode        = json.user_code;
  deviceCodeState.verificationUri = json.verification_uri;
  deviceCodeState.deviceCode      = json.device_code;
  deviceCodeState.expiresAt       = Date.now() + Number(json.expires_in) * 1000;
  deviceCodeState.interval        = Number(json.interval) || 5;
  deviceCodeState.startedAt       = Date.now();
  deviceCodeState.error           = null;
  deviceCodeState.completedAt     = null;

  // Lancer le polling en arrière-plan
  pollDeviceCodeUntilComplete().catch(e => {
    deviceCodeState.error = e.message;
    deviceCodeState.inProgress = false;
    console.error(`[inboxWatcher] device code polling échec: ${e.message}`);
  });

  return {
    userCode:          json.user_code,
    verificationUri:   json.verification_uri,
    expiresAt:         deviceCodeState.expiresAt,
    message:           json.message,
  };
}

async function pollDeviceCodeUntilComplete() {
  while (deviceCodeState.inProgress) {
    if (Date.now() > deviceCodeState.expiresAt) {
      deviceCodeState.error = 'Device code expiré sans approbation utilisateur';
      deviceCodeState.inProgress = false;
      return;
    }
    await sleep(deviceCodeState.interval * 1000);
    const params = new URLSearchParams();
    params.append('client_id',    PUBLIC_CLIENT_ID);
    params.append('grant_type',   'urn:ietf:params:oauth:grant-type:device_code');
    params.append('device_code',  deviceCodeState.deviceCode);
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.access_token) {
      const accessExpiresAt = Date.now() + (Number(json.expires_in) - 30) * 1000;
      // Récupère l'email du compte authentifié via /me
      let accountEmail = null;
      try {
        const me = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${json.access_token}` },
        }).then(r => r.json());
        accountEmail = me?.mail || me?.userPrincipalName || null;
      } catch {}
      saveTokenToDisk({
        refreshToken:    json.refresh_token,
        accessToken:     json.access_token,
        accessExpiresAt,
        scope:           json.scope,
        accountEmail,
        updatedAt:       new Date().toISOString(),
      });
      _cachedAccessToken = { accessToken: json.access_token, expiresAt: accessExpiresAt };
      deviceCodeState.inProgress  = false;
      deviceCodeState.completedAt = Date.now();
      console.log(`[inboxWatcher] ✅ device code flow complété pour ${accountEmail || '(compte inconnu)'}`);
      return;
    }
    // Codes d'erreur OAuth standard
    const errCode = json.error;
    if (errCode === 'authorization_pending') {
      continue; // normal, on re-poll
    }
    if (errCode === 'slow_down') {
      deviceCodeState.interval += 5;
      continue;
    }
    if (errCode === 'authorization_declined') {
      deviceCodeState.error = 'Utilisateur a refusé l\'accès';
      deviceCodeState.inProgress = false;
      return;
    }
    if (errCode === 'expired_token' || errCode === 'bad_verification_code') {
      deviceCodeState.error = `Token error: ${errCode}`;
      deviceCodeState.inProgress = false;
      return;
    }
    // Erreur inattendue
    deviceCodeState.error = `OAuth error: ${errCode || res.status} — ${json.error_description || ''}`;
    deviceCodeState.inProgress = false;
    return;
  }
}

function getDeviceCodeStatus() {
  const stored = loadTokenFromDisk();
  return {
    inProgress:        deviceCodeState.inProgress,
    userCode:          deviceCodeState.userCode,
    verificationUri:   deviceCodeState.verificationUri,
    expiresAt:         deviceCodeState.expiresAt,
    startedAt:         deviceCodeState.startedAt ? new Date(deviceCodeState.startedAt).toISOString() : null,
    completedAt:       deviceCodeState.completedAt ? new Date(deviceCodeState.completedAt).toISOString() : null,
    error:             deviceCodeState.error,
    authenticated:     !!stored?.refreshToken,
    accountEmail:      stored?.accountEmail || null,
    tokenUpdatedAt:    stored?.updatedAt || null,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function graphMailboxPath() {
  // En mode delegated (device code), /me/ est le chemin idiomatique
  return '/me';
}

async function graphFetch(pathAndQuery, init = {}) {
  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0${pathAndQuery}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Graph ${init.method || 'GET'} ${pathAndQuery} → ${res.status}: ${t.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return await res.json();
}

// ─── LISTER LES RÉPONSES RÉCENTES ──────────────────────────────────────────
async function listRecentReplies({ sinceIso } = {}) {
  const since = sinceIso || new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const filter = `receivedDateTime ge ${since}`;
  const qs = `$filter=${encodeURIComponent(filter)}&$top=50&$orderby=receivedDateTime%20desc&$select=id,conversationId,internetMessageId,subject,from,toRecipients,receivedDateTime,bodyPreview,body,isDraft`;
  const res = await graphFetch(`${graphMailboxPath()}/mailFolders/inbox/messages?${qs}`);
  return Array.isArray(res?.value) ? res.value : [];
}

// ─── MATCHER UNE RÉPONSE À UNE RELANCE ─────────────────────────────────────
function matchReplyToRelance(msg) {
  const fromAddr = (msg.from?.emailAddress?.address || '').toLowerCase();
  if (!fromAddr) return null;
  const receivedAt = new Date(msg.receivedDateTime || 0).getTime();
  const subjNorm = normalizeSubject(msg.subject);

  // (a) conversationId — le plus fiable
  if (msg.conversationId) {
    const m = state.relances.find(r => r.conversationId === msg.conversationId);
    if (m) return { relance: m, strategy: 'conversationId' };
  }

  // (b) email expéditeur = destinataire de notre relance + reçu après l'envoi
  const fromCandidates = state.relances.filter(r => r.contactEmail === fromAddr);
  if (fromCandidates.length) {
    const valid = fromCandidates
      .filter(r => new Date(r.sentAt).getTime() < receivedAt)
      .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
    if (valid.length) return { relance: valid[0], strategy: 'from+sentAt' };
  }

  // (c) fallback : match sujet (Outlook préfixe "Re:")
  if (subjNorm) {
    for (const r of state.relances) {
      const rNorm = normalizeSubject(r.subject);
      if (rNorm && subjNorm.includes(rNorm.slice(0, 30))) {
        return { relance: r, strategy: 'subject' };
      }
    }
  }

  return null;
}

function normalizeSubject(s) {
  return String(s || '')
    .replace(/^(re|rép|fw|tr|fwd|rép\.)\s*:\s*/gi, '')
    .trim()
    .toLowerCase();
}

// ─── CLAUDE — CLASSIFICATION ───────────────────────────────────────────────

const CATEGORIES = [
  'rdv',
  'info_programme',
  'info_typologie_specifique',
  'autre_programme',
  'refus',
  'negociation_prix',
  'question_technique',
  'hors_sujet',
  'autre',
];

const LABEL_FOR_CATEGORY = {
  rdv:                        'Demande de RDV',
  info_programme:             'Demande d\'infos programme',
  info_typologie_specifique:  'Demande typologie spécifique',
  autre_programme:            'Demande autre programme',
  refus:                      'Refus / Désinscription',
  negociation_prix:           'Négociation prix',
  question_technique:         'Question technique',
  hors_sujet:                 'Hors sujet',
  autre:                      'Autre',
};

const CLASSIFICATION_PROMPT = `Tu es un classifieur de réponses prospect dans le cadre de la commercialisation de logements neufs en France (Catella Residential).

Contexte : un prospect a rempli un formulaire sur un programme immobilier neuf, on lui a envoyé un email de relance à J+1 demandant des précisions sur sa recherche (typologie, étage, exposition, budget). Il vient de répondre. Tu classes sa réponse dans UNE des catégories ci-dessous.

TAXONOMIE :

• rdv — Demande explicite de RDV / appel / visite / rencontre, ou accepte une proposition de RDV, ou propose un créneau.
  Ex : "Je suis dispo mardi 14h", "On peut s'appeler demain ?", "Quand puis-je visiter l'appart-témoin ?".

• info_programme — Demande d'infos générales sur le programme : plaquette, plans, grille de prix, disponibilités globales, notice descriptive, visite virtuelle.
  Ex : "Pouvez-vous m'envoyer la plaquette ?", "Quels biens sont encore disponibles ?".

• info_typologie_specifique — Demande précise sur un bien particulier (typologie + étage/exposition/budget).
  Ex : "Je cherche un T3 au 3ème avec balcon sud", "Un T2 à moins de 400k€ à l'étage élevé".

• autre_programme — Prospect pas intéressé par CE programme mais ouvert à d'autres programmes Catella / autres secteurs géographiques.
  Ex : "Ce programme ne me convient pas, avez-vous autre chose à Boulogne ?".

• refus — Veut être désinscrit, retiré de la liste, projet annulé, plus à la recherche.
  Ex : "Merci de ne plus me contacter", "Je ne suis plus à la recherche".

• negociation_prix — Négocie prix, TVA, frais de notaire, financement, décote, remise, geste commercial.
  Ex : "C'est trop cher", "Pouvez-vous faire un geste ?", "Vous prenez la TVA à votre charge ?".

• question_technique — Questions sur matériaux, DPE, date de livraison précise, DTG, fiscalité (Pinel, LMNP…), juridique, copropriété.
  Ex : "Quel est le DPE ?", "Date exacte de livraison ?", "Loi Pinel applicable ?".

• hors_sujet — Out-of-office, transfert interne, newsletter automatique, message vide, ne contient pas de vraie demande prospect.
  Ex : "Je suis en congé jusqu'au 30", "Transféré à mon mari pour suite".

• autre — Aucune des catégories ci-dessus ne correspond clairement.

Règle de priorité si plusieurs intentions cohabitent : prends la plus "engageante".
  rdv > info_typologie_specifique > info_programme > autre_programme > negociation_prix > question_technique > refus > hors_sujet > autre.

FORMAT DE RÉPONSE — JSON strict, rien avant, rien après :
{
  "category": "<une valeur exacte parmi les 9>",
  "confidence": "high|medium|low",
  "reasoning": "<1 phrase FR expliquant le choix>",
  "extracted": {
    "wantsRDV": <true|false>,
    "proposedSlot": "<string ou null>",
    "mentionedTypologie": "<T1|T2|T3|T4|T5|null>",
    "mentionedBudget": "<string ou null>",
    "mentionedEtage": "<string ou null>",
    "mentionedExposition": "<string ou null>",
    "sentiment": "positif|neutre|négatif"
  }
}`;

async function callClaude({ systemPrompt, userMessage, maxTokens = 1500 }) {
  if (!CONFIG.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY non configuré');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      CONFIG.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.content?.[0]?.text || '';
}

async function classifyReply({ subject, body, leadContext = {}, programContext = {} }) {
  const userMsg = [
    `=== Contexte lead ===`,
    `Nom contact : ${leadContext.contactName || '(inconnu)'}`,
    `Email       : ${leadContext.contactEmail || '(inconnu)'}`,
    `Programme   : ${programContext.name || leadContext.programName || '(inconnu)'}`,
    `Ville       : ${programContext.ville || '(inconnue)'}`,
    `Promoteur   : ${programContext.promoteur || '(inconnu)'}`,
    ``,
    `=== Réponse du prospect ===`,
    `Sujet : ${subject || '(vide)'}`,
    ``,
    body || '(corps vide)',
  ].join('\n');
  const raw = await callClaude({
    systemPrompt: CLASSIFICATION_PROMPT,
    userMessage:  userMsg,
    maxTokens:    500,
  });
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!CATEGORIES.includes(parsed.category)) parsed.category = 'autre';
    parsed.extracted = parsed.extracted || {};
    return parsed;
  } catch (e) {
    console.error(`[classifyReply] parse error: ${e.message} — raw: ${raw.slice(0, 200)}`);
    return {
      category:   'autre',
      confidence: 'low',
      reasoning:  `LLM parse error: ${e.message}`,
      extracted:  {},
    };
  }
}

// ─── CLAUDE — RÉDACTION DU BROUILLON ──────────────────────────────────────

const DRAFT_PROMPT = `Tu rédiges un brouillon de réponse email pour Norman Dadon, Directeur des ventes chez Catella Residential (commercialisation de logements neufs).

Le brouillon sera posé dans le dossier "Brouillons" d'Outlook de Norman. Il relira, éditera si besoin, puis enverra lui-même. Le brouillon ne part JAMAIS automatiquement.

TON NORMAN (impératif — ne pas s'écarter) :
- Direct, chaleureux, professionnel. Pas robotique, pas obséquieux.
- Vouvoiement systématique.
- Pas de formules creuses du type "N'hésitez pas", "Je reste à votre disposition", "Je ne manquerai pas de vous tenir informé".
- Pas d'emojis.
- Pas de "cher Monsieur" ni "chère Madame" → utilise la salutation fournie.
- Court et efficace : 3 à 5 phrases maxi, une proposition concrète.
- Toujours se terminer par "Bien à vous," (sur sa propre ligne) — la signature est ajoutée automatiquement après donc NE PAS l'inclure.

RÈGLES CRITIQUES — NE JAMAIS LES VIOLER :
- N'INVENTE JAMAIS : prix d'un lot, date exacte de livraison, disponibilité précise, typologie dispo, TVA applicable, dispositif fiscal (Pinel / LMNP), frais de notaire, rentabilité, étage/orientation/parking d'un lot spécifique.
- Si le prospect demande du CONCRET (prix, dispo, plan d'un lot, date de livraison…) → réponse standard : on les étudie ensemble lors d'un RDV rapide, proposer le lien Bookings.
- Si négociation prix → pas de concession ni de refus sec, proposer un échange vocal.
- Si refus/désinscription → acquitter brièvement, confirmer la prise en compte.
- Si out-of-office / hors sujet → shouldDraft=false.

LIEN BOOKINGS (à insérer tel quel dans le HTML pour les réponses qui appellent un RDV) :
{{BOOKING_URL}}

FORMAT DE SORTIE — JSON strict, rien avant, rien après :
{
  "shouldDraft": <true|false>,
  "html": "<corps HTML du brouillon, sans signature, terminé par 'Bien à vous,'>",
  "internalNote": "<1-2 phrases FR à destination de Norman : points d'attention, vérifs à faire avant envoi>"
}

EXIGENCES sur "html" :
- Démarre par "<p>Bonjour {salutation fournie},</p>"
- Contenu en paragraphes <p>...</p> (pas de <div>, pas de <ul> sauf si vraiment utile)
- Quand tu insères le lien Bookings, utilise : <a href="{{BOOKING_URL}}">réserver un créneau</a>
- Termine par "<p>Bien à vous,</p>"
- Pas de signature, pas de "Norman DADON" à la fin`;

async function draftResponse({ category, classification, replyBody, replySubject, leadContext = {}, programContext = {} }) {
  const bookingUrl = CONFIG.BOOKING_URL || '';
  const systemPrompt = DRAFT_PROMPT.replaceAll('{{BOOKING_URL}}', bookingUrl);
  const salutation = leadContext.salutation
    || leadContext.contactName
    || 'Madame, Monsieur';

  const userMsg = [
    `=== Contexte lead ===`,
    `Contact            : ${leadContext.contactName || '(inconnu)'}`,
    `Salutation à employer : "${salutation}"`,
    `Email              : ${leadContext.contactEmail || '(inconnu)'}`,
    `Programme          : ${programContext.name || leadContext.programName || '(inconnu)'}`,
    `Ville              : ${programContext.ville || '(inconnue)'}`,
    `Promoteur          : ${programContext.promoteur || '(inconnu)'}`,
    `Accroche programme : ${programContext.accroche || '(aucune)'}`,
    ``,
    `=== Catégorie classée ===`,
    `category  : ${category}`,
    `reasoning : ${classification?.reasoning || ''}`,
    `extracted : ${JSON.stringify(classification?.extracted || {}, null, 2)}`,
    ``,
    `=== Réponse du prospect (à traiter) ===`,
    `Sujet : ${replySubject || '(vide)'}`,
    ``,
    replyBody || '(corps vide)',
  ].join('\n');

  const raw = await callClaude({
    systemPrompt,
    userMessage: userMsg,
    maxTokens:   1500,
  });
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      shouldDraft:   !!parsed.shouldDraft,
      html:          parsed.html || '',
      internalNote:  parsed.internalNote || '',
    };
  } catch (e) {
    console.error(`[draftResponse] parse error: ${e.message} — raw: ${raw.slice(0, 300)}`);
    return {
      shouldDraft:  false,
      html:         '',
      internalNote: `Erreur parsing LLM: ${e.message}`,
    };
  }
}

// ─── OUTLOOK — CRÉATION DU BROUILLON DANS LE THREAD ───────────────────────

function wrapWithSignature(bodyHtml) {
  const signature = `<p style="margin-top: 24px; font-size: 13px; line-height: 1.5;">
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
  return `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222;">${bodyHtml}${signature}</div>`;
}

// Graph : POST /users/{email}/messages/{id}/createReply → renvoie un draft dans le thread.
// Puis PATCH /users/{email}/messages/{draftId} pour injecter le body HTML.
async function createDraftInOutlook({ originalMessageId, htmlBody }) {
  if (!originalMessageId) throw new Error('originalMessageId manquant');
  const replyDraft = await graphFetch(`${graphMailboxPath()}/messages/${originalMessageId}/createReply`, {
    method: 'POST',
    body:   JSON.stringify({}),
  });
  if (!replyDraft || !replyDraft.id) {
    throw new Error('createReply n\'a pas renvoyé d\'id');
  }
  await graphFetch(`${graphMailboxPath()}/messages/${replyDraft.id}`, {
    method: 'PATCH',
    body:   JSON.stringify({
      body: { contentType: 'HTML', content: wrapWithSignature(htmlBody) },
    }),
  });
  return {
    draftId: replyDraft.id,
    webLink: replyDraft.webLink || null,
  };
}

// ─── EXTRACTION DU CORPS TEXTE (depuis HTML Graph) ────────────────────────
function extractBodyText(msg) {
  if (!msg) return '';
  const body = msg.body?.content;
  const type = msg.body?.contentType;
  if (!body) return msg.bodyPreview || '';
  if (type === 'text') return body;
  // HTML → texte (dégradé mais suffisant pour classification/drafting)
  return String(body)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── HANDLE REPLY — POINT D'ENTRÉE PRINCIPAL ──────────────────────────────
// options.dryRun = true → ne crée PAS le brouillon, ne pose PAS la sales-action.
async function handleReply({
  originalMessage = {},
  relance = null,
  leadContext,
  programContext,
  dryRun = false,
}) {
  // Rate-limit : max N réponses traitées sur une même relance dans 24h (anti-boucle)
  if (relance && (relance.repliesReceived || 0) >= MAX_REPLIES_PER_CONV_24H) {
    const lastAt = relance.lastReplyAt ? new Date(relance.lastReplyAt).getTime() : 0;
    if (Date.now() - lastAt < 24 * 60 * 60 * 1000) {
      console.log(`[inboxWatcher] rate-limit: relance ${relance.id} a déjà ${relance.repliesReceived} réponses traitées en 24h → skip`);
      return { skipped: true, reason: 'rate_limit' };
    }
  }

  const subject = originalMessage.subject || '';
  const body    = extractBodyText(originalMessage);

  const leadCtx = leadContext || {
    leadId:       relance?.leadId,
    programId:    relance?.programId,
    contactEmail: relance?.contactEmail,
    contactName:  relance?.contactName,
    programName:  relance?.programName,
    salutation:   relance?.contactName || 'Madame, Monsieur',
  };
  const programCtx = programContext || { name: relance?.programName };

  // 1. Classification — try/catch isolé
  let classification;
  try {
    classification = await classifyReply({ subject, body, leadContext: leadCtx, programContext: programCtx });
  } catch (e) {
    console.error(`[inboxWatcher] classifyReply échec: ${e.message}`);
    classification = { category: 'autre', confidence: 'low', reasoning: `classify error: ${e.message}`, extracted: {} };
  }

  // 2. Rédaction — try/catch isolé
  let draft;
  try {
    draft = await draftResponse({
      category:       classification.category,
      classification,
      replyBody:      body,
      replySubject:   subject,
      leadContext:    leadCtx,
      programContext: programCtx,
    });
  } catch (e) {
    console.error(`[inboxWatcher] draftResponse échec: ${e.message}`);
    draft = { shouldDraft: false, html: '', internalNote: `draft error: ${e.message}` };
  }

  let draftResult = null;
  let adleadResult = null;

  // 3. Création du brouillon Outlook (si applicable et pas dryRun)
  if (!dryRun && draft.shouldDraft && originalMessage.id && hasGraphCreds()) {
    try {
      draftResult = await createDraftInOutlook({
        originalMessageId: originalMessage.id,
        htmlBody:          draft.html,
      });
      console.log(`[inboxWatcher] ✅ brouillon Outlook créé: ${draftResult.draftId}`);
    } catch (e) {
      console.error(`[inboxWatcher] ⚠️ createDraft échec: ${e.message}`);
      draftResult = { error: e.message };
    }
  }

  // 4. Sales-action Adlead (best-effort, ne bloque rien)
  if (!dryRun && relance && helpers?.adleadPost) {
    try {
      adleadResult = await createAdleadReplySalesAction({
        programId: relance.programId,
        leadId:    relance.leadId,
        category:  classification.category,
        reasoning: classification.reasoning,
      });
    } catch (e) {
      adleadResult = { error: e.message };
      console.log(`[inboxWatcher] (info) Adlead sales-action échec: ${e.message.slice(0, 150)}`);
    }
  }

  // 5. Tracking — persisté en mémoire + disque
  if (!dryRun) {
    if (relance) {
      relance.repliesReceived = (relance.repliesReceived || 0) + 1;
      relance.lastReplyAt     = new Date().toISOString();
      saveRelances();
    }
    state.replies.push({
      id:                  originalMessage.id || `test_${Date.now()}`,
      leadId:              relance?.leadId || null,
      programId:           relance?.programId || null,
      conversationId:      originalMessage.conversationId || null,
      from:                originalMessage.from?.emailAddress?.address || null,
      subject,
      receivedAt:          originalMessage.receivedDateTime || new Date().toISOString(),
      category:            classification.category,
      confidence:          classification.confidence,
      reasoning:           classification.reasoning,
      draftCreated:        !!draftResult?.draftId,
      draftId:             draftResult?.draftId || null,
      draftError:          draftResult?.error || null,
      adleadActionCreated: !!(adleadResult && !adleadResult.error),
      adleadError:         adleadResult?.error || null,
      processedAt:         new Date().toISOString(),
    });
    if (state.replies.length > 500) state.replies = state.replies.slice(-500);
    saveReplies();
  }

  return {
    classification,
    draft,
    draftResult,
    adleadResult,
  };
}

async function createAdleadReplySalesAction({ programId, leadId, category, reasoning }) {
  const label = LABEL_FOR_CATEGORY[category] || category;
  const scheduled_at = toAdleadDateTime(new Date(Date.now() + 5 * 60 * 1000));
  const comment = `Réponse prospect — ${label}. ${reasoning || ''}`.slice(0, 500);
  // Adlead n'accepte pas forcément "email-received" dans l'énum → on essaie, retry en send-email.
  try {
    return await helpers.adleadPost(`/programs/${programId}/leads/${leadId}/sales-actions`, {
      type: 'email-received',
      scheduled_at, priority: 'medium', comment,
    });
  } catch (e) {
    return await helpers.adleadPost(`/programs/${programId}/leads/${leadId}/sales-actions`, {
      type: 'send-email',
      scheduled_at, priority: 'medium', comment,
    });
  }
}

function toAdleadDateTime(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, '.000000Z');
}

// ─── POLL (scheduler) ─────────────────────────────────────────────────────
async function poll() {
  if (!CONFIG.REPLY_HANDLER_ENABLED) return { skipped: true, reason: 'REPLY_HANDLER_ENABLED=false' };
  if (!CONFIG.ANTHROPIC_API_KEY)     return { skipped: true, reason: 'ANTHROPIC_API_KEY manquant' };
  if (!hasGraphCreds())              return { skipped: true, reason: 'Graph creds manquants' };

  try {
    const sinceIso = state.lastPoll || new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const msgs = await listRecentReplies({ sinceIso });
    const results = [];
    for (const msg of msgs) {
      if (msg.isDraft) continue;
      const fromAddr = (msg.from?.emailAddress?.address || '').toLowerCase();
      if (fromAddr === (CONFIG.SENDER_EMAIL || '').toLowerCase()) continue; // nous-mêmes
      if (state.replies.some(r => r.id === msg.id)) continue; // déjà traité

      const match = matchReplyToRelance(msg);
      if (!match) continue;

      console.log(`[inboxWatcher] match: "${msg.subject}" ← ${fromAddr} (strategy=${match.strategy}, lead=${match.relance.leadId})`);
      try {
        const r = await handleReply({ originalMessage: msg, relance: match.relance });
        results.push({ id: msg.id, from: fromAddr, subject: msg.subject, category: r.classification?.category, draft: !!r.draftResult?.draftId });
      } catch (e) {
        console.error(`[inboxWatcher] handleReply échec msg ${msg.id}: ${e.message}`);
        results.push({ id: msg.id, error: e.message });
      }
    }
    state.lastPoll = new Date().toISOString();
    savePollState();
    return { polled: msgs.length, matched: results.length, results };
  } catch (e) {
    console.error(`[inboxWatcher] poll erreur: ${e.message}`);
    return { error: e.message };
  }
}

// ─── DASHBOARD / INSPECTION ───────────────────────────────────────────────
function getStats() {
  const byCategory = {};
  for (const r of state.replies) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  }
  return {
    graphConfigured:   hasGraphCreds(),
    anthropicConfigured: !!CONFIG.ANTHROPIC_API_KEY,
    replyHandlerEnabled: !!CONFIG.REPLY_HANDLER_ENABLED,
    relancesTracked:   state.relances.length,
    repliesProcessed:  state.replies.length,
    lastPoll:          state.lastPoll,
    byCategory,
  };
}

function getRecentReplies(limit = 50) {
  return state.replies.slice(-limit).reverse();
}

function getRecentRelances(limit = 50) {
  return state.relances.slice(-limit).reverse();
}

module.exports = {
  init,
  registerSentRelance,
  listRecentReplies,
  matchReplyToRelance,
  classifyReply,
  draftResponse,
  createDraftInOutlook,
  handleReply,
  poll,
  getStats,
  getRecentReplies,
  getRecentRelances,
  hasGraphCreds,
  startDeviceCodeFlow,
  getDeviceCodeStatus,
  CATEGORIES,
  LABEL_FOR_CATEGORY,
};
