# Lead Automation — Catella

Automatisation des relances commerciales : **Adlead → Node.js (Railway) → Outlook + WhatsApp + Telegram**

Chaque nouveau lead dans Adlead est mis en file et suivi sur ~17 jours, avec trois cadences de relance :

1. **Règle 1 — J+1** : un email + WhatsApp ~24h après la réception (instantané pour les programmes listés dans `INSTANT_PROGRAM_IDS`). Désactivé en auto-send depuis 2026-05-18 : Norman traite le J+1 à la main, le record reste en `j1-manual-pending` pour que les règles 2 et 3 prennent le relais.
2. **Règle 2 — J+3 matin** : 3 messages d'escalation (email "doux" → WhatsApp template Meta → email "final") sur 3 jours consécutifs, dès que le lead passe en statut Adlead `pending` depuis ≥24h.
3. **Règle 3 — J+15** : 3 messages d'escalation (email → WhatsApp template Meta → email) à J+15/+16/+17 calculés sur `last_interaction_at`, pour les leads en stagnation `pending`.

Toutes les règles sont arrêtées dès que le lead change de statut côté Adlead (= prospect a répondu OU commercial a re-statué).

Les envois sont limités à la **fenêtre 9h–20h Paris** (configurable) et **bloqués le dimanche**.

---

## Architecture

```
Adlead (webhook interest:created)
   │
   ▼
Railway / server.js (Node 18+, Express)
   │  persist pending & processed leads dans /data (volume persistant Railway)
   │  scheduler interne (tick toutes les 5 min)
   │  crons quotidiens J+3 matin (9h15) et J+15 (10h)
   │
   ├──► Power Automate (flow HTTP) ──► Outlook Norman ──► client
   ├──► Power Automate (2e flow)    ──► mail interne Norman
   ├──► Twilio Content API          ──► WhatsApp client (templates Meta approved)
   ├──► Telegram bot                ──► canal "urgent" Norman
   │
   ◄── Power Automate "Reply Watcher" ──── /webhook/inbox-reply  (réponses prospect par mail)
   ◄── Twilio                         ──── /webhook/whatsapp-incoming  (réponses prospect WhatsApp)
```

Dashboard temps réel sur `https://lead-automation-production-33e8.up.railway.app/`.

---

## Variables d'environnement (Railway)

Voir `.env.example` pour le template. Liste exhaustive par groupe :

### Adlead
- `ADLEAD_API_KEY` — clé API (Paramètres > API Keys, clé #223 active)
- `ADLEAD_WEBHOOK_SECRET` — secret de signature HMAC du webhook entrant
- `ADLEAD_TENANT` — slug du CRM (`catella`)
- `ADLEAD_API_BASE` — `https://app.adlead.immo/api/v1`
- `ADLEAD_UI_BASE` — base URL des liens "voir la fiche" dans les notifs internes
- `SKIP_REGISTRATIONS_CHECK` — `true` par défaut (le check via `/registrations` est obsolète depuis qu'Adlead filtre les dénonciations à la source, et le scope n'est plus accordé à la clé #223)

### Email (Power Automate)
- `POWER_AUTOMATE_URL` — trigger HTTP du flow principal (envoi au client)
- `POWER_AUTOMATE_SECRET` — header `x-shared-secret` (32+ chars)
- `POWER_AUTOMATE_INBOX_SECRET` — header `X-PA-Secret` pour le webhook `/webhook/inbox-reply` (reply watcher PA)
- `SENDER_EMAIL` — adresse affichée (`norman.dadon@catella.com`)
- `INTERNAL_NOTIF_EMAIL` — destinataire du mail interne
- `INTERNAL_NOTIF_PHONE` — numéro WhatsApp interne de Norman pour les notifs urgentes
- `BOOKING_URL` — lien Outlook Booking affiché dans les mails (`{lien_rdv}`)

### Cadences (kill switches)
- `J1_AUTO_SEND_DISABLED` — `true` en prod : la règle 1 ne déclenche plus d'envoi auto, le record passe en `j1-manual-pending` pour Norman
- `J3M_ENABLED` / `J3M_SEND_DISABLED` — règle 2 (J+3 matin) on/off et belt-and-suspenders
- `J3M_CRON_HOUR_PARIS` / `J3M_CRON_MIN_MINUTE` — heure du cron J+3 (défaut 9h15 Paris)
- `WHATSAPP_J3M_ENABLED` + `TWILIO_TEMPLATE_J3M_DAY2` — WhatsApp jour 2 de la règle 2 (fallback email si vide)
- `J15_ENABLED` / `J15_SEND_DISABLED` — règle 3 (J+15) on/off et belt-and-suspenders
- `J15_DELAY_DAYS` — délai avant 1ère relance J+15 (défaut 15)
- `J15_CRON_HOUR_PARIS` — heure du cron J+15 (défaut 10h Paris)
- `WHATSAPP_J15_ENABLED` + `TWILIO_TEMPLATE_RELANCE_J15` — WhatsApp jour 1 de la règle 3
- `TWILIO_TEMPLATE_J16` — WhatsApp jour 2 de la règle 3 (fallback email si vide)

### Timing global
- `DELAY_HOURS` — attente avant règle 1 (défaut 24)
- `SCHEDULER_INTERVAL_MS` — fréquence du tick scheduler (défaut 300000 = 5 min)
- `INSTANT_PROGRAM_IDS` — CSV des programIds qui bypassent le délai 24h (envoi au prochain tick)
- `EXCLUDED_PROGRAM_IDS` — CSV des programIds totalement exclus des relances automatiques
- `SEND_HOUR_START_PARIS` — heure inclusive début fenêtre d'envoi (défaut 9)
- `SEND_HOUR_END_PARIS` — heure exclusive fin fenêtre d'envoi (défaut 20). Dimanches bloqués indépendamment.

### WhatsApp (Twilio + Meta)
- `WHATSAPP_ENABLED` — kill switch global. `true` active l'envoi, sinon rien ne part.
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` — credentials Twilio
- `TWILIO_WHATSAPP_FROM` — numéro expéditeur, format `whatsapp:+33...` (prod dédié Catella)
- `TWILIO_TEMPLATE_RELANCE_J1` — ContentSid du template Meta "relance_j1_catella" (sinon fallback Body sandbox)
- `TWILIO_VALIDATE_SIGNATURE` — `true` par défaut : vérifie la signature HMAC de Twilio sur `/webhook/whatsapp-incoming` (mettre `false` uniquement en dev)

### Telegram (canal urgent)
- `TELEGRAM_BOT_TOKEN` — token du bot `@Catella_notif_bot` (créé via @BotFather)
- `TELEGRAM_CHAT_ID` — chat_id de Norman (récupéré après `/start` sur le bot)
- `TELEGRAM_NOTIF_ENABLED` — `true` par défaut, `false` pour kill switch ciblé Telegram

### Reply handler (pilote — Graph + Claude)
- `REPLY_HANDLER_ENABLED` — master switch. Tant que `false`, aucun poll Graph.
- `ANTHROPIC_API_KEY` — clé API Anthropic pour classifier la réponse + rédiger le brouillon
- `ANTHROPIC_MODEL` — défaut `claude-sonnet-4-6`
- `REPLY_POLL_INTERVAL_MS` — fréquence du poll inbox Graph (défaut 3 min)
- Auth Graph : device code flow → refresh_token stocké dans `DATA_DIR/graph_token_cache.json` (pas d'env var, voir `AUTH_DEVICE_CODE.md`)

### Tag & statut Adlead (best-effort)
- `TAG_UUID_RELANCE_J1` — UUID du tag "Relance J+1 envoyée" (créé manuellement dans Adlead). Vide = skip silencieux.
- `STATUS_UPDATE_ENABLED` — `true` par défaut. Tente un `PATCH /leads/{id}` pour passer le statut à `pending`. Renvoie 405 tant qu'Adlead n'a pas livré la route (annoncée pour l'été).

### Kill switches d'urgence
- `PIPELINE_DISABLED` — nucléaire : le scheduler ne traite plus aucun lead (le webhook continue à encaisser, rien n'est perdu)
- `INTERNAL_NOTIF_DISABLED` — coupe les mails internes à Norman (mails prospects partent quand même)

### Persistance & serveur
- `DATA_DIR` — chemin du volume persistant (défaut `/data` sur Railway)
- `PORT` — port Express (défaut 3000)

---

## Règle métier : leads dénoncés / hors-jeu

Un lead est bloqué (aucun envoi, aucune relance future) si **au moins une** des 3 conditions est vraie sur la fiche complète récupérée via `/programs/{pid}/leads/{lid}` :

1. `is_under_prescription === true` → status `denounced` (prescripteur a revendiqué le lead)
2. `lead.status ≠ "to-process"` → status `cancelled` (commercial a déjà re-statué)
3. `lead.discard_reason` non null → status `cancelled` (lead mis hors-jeu pour une raison quelconque)

Le check via `/registrations` (historique) est désactivé par défaut (`SKIP_REGISTRATIONS_CHECK=true`) parce que :
- Adlead filtre désormais les dénonciations à la source côté webhook
- La clé API #223 n'a plus le scope `registrations:read` (403)

Les 3 conditions ci-dessus tournent **avant** chaque envoi de chacune des 3 règles.

---

## Statuts possibles d'un lead traité

Champ `status` dans `/api/leads` :

| Statut | Signification |
|--------|---------------|
| `sent` | Email envoyé (et WhatsApp si activé). |
| `j1-manual-pending` | Règle 1 désactivée — Norman doit envoyer manuellement. Reste éligible aux règles 2 et 3. |
| `cancelled` | Commercial a pris la main entre la réception et le traitement. Rien envoyé. |
| `optout` | Contact a opt-out par email. |
| `denounced` | `is_under_prescription=true` — ERP/prescripteur a la main. |
| `skipped` | Pas d'email sur le contact, ou contact absent, ou programme exclu. |
| `error` | Erreur bloquante après plusieurs tentatives. |

---

## Endpoints

### Monitoring
- `GET /api/health` — santé serveur, compteurs, état du volume, flags des règles 2/3
- `GET /api/leads` — tous les leads traités (récents en premier)
- `GET /api/pending` — file d'attente
- `GET /api/stats` — agrégats dashboard (counts, byDay 14j, byProgram, recent, WhatsApp)
- `GET /api/dashboard/replies` — réponses prospect (email + WhatsApp) consolidées

### Webhooks entrants
- `POST /webhook/adlead` — webhook Adlead `interest:created` (HMAC vérifié)
- `POST /webhook/inbox-reply` — Power Automate "Reply Watcher" : réponses mail prospect (bypass Conditional Access Catella). Retourne synchroniquement un draft HTML + `matched` (`'true'`/`'false'` en string pour compat PA Condition).
- `POST /webhook/whatsapp-incoming` — Twilio : réponses WhatsApp prospect (signature HMAC vérifiée)

### Test / dry-run
- `POST /api/scheduler/run` — force un tick scheduler immédiat
- `POST /api/test/process-now` — traite un lead immédiatement. Body : `{"leadId":"...","programId":"...","force":"1"}`
- `POST /api/test/adlead-update` — teste les helpers Adlead post-envoi sans envoyer de mail
- `POST /api/test/telegram` — envoie un ping Telegram de test
- `POST /api/test/reply-handler` — déclenche le reply handler sur un payload donné
- `GET /api/test/adlead-probe` — probe en lecture seule les endpoints Adlead avec la clé courante
- `GET /api/test/j15-dry-run` — liste les candidats J+15 qui seraient relancés au prochain tick
- `GET /api/test/j3m-dry-run` — idem pour J+3 matin
- `GET /api/test/lead-dump` / `registrations-dump` — dump brut d'un lead / des registrations pour debug

### Admin (one-shots)
- `POST /api/admin/clear-pending` — purge la queue (archive en `cancelled` avec `reason=admin clear-pending`)
- `POST /api/admin/register-test-relance` — injecte un faux lead processed pour tester E2E le flow reply
- `POST /api/admin/rehydrate-j1-manual-pending` — re-rentre les leads "perdus" en `j1-manual-pending` après bascule du kill switch (idempotent)
- `POST /api/admin/resolve-program-names` — résout les `Programme #XXX` inconnus dans le dashboard via lookup Adlead
- `POST /api/admin/j15-mark-bad-names` — marque les leads avec un nom de programme bidon pour exclure des futurs ticks J+15

### Auth Graph (reply handler)
- `GET /api/auth/start` — démarre le device code flow Microsoft Graph
- `GET /api/auth/status` — état du refresh token

---

## Déploiement / opérations courantes

### Modifier une env var sur Railway
1. Dashboard Railway → service `lead-automation` → onglet **Variables**
2. Modifier / ajouter la variable → bannière **Apply N changes**
3. Cliquer **Deploy** → ~1 min de redéploiement

### Couper WhatsApp en urgence
Railway → Variables → `WHATSAPP_ENABLED` → `false` → Deploy.

### Couper le pipeline complet
Railway → Variables → `PIPELINE_DISABLED` → `true` → Deploy. Les webhooks continuent d'encaisser, rien n'est perdu.

### Push de code (depuis un Mac)
```bash
git add server.js
git commit -m "feat: ma nouvelle feature"
git push
```
Railway détecte le push sur `main` et redéploie automatiquement.

Si le terminal local ne peut pas push (firewall) : éditer le fichier directement dans l'UI GitHub et commit via le bouton "Commit changes..." — Railway tire dessus pareil.

---

## Fichiers du projet

- `server.js` — backend (webhook, scheduler, crons règles 2/3, helpers Adlead / Twilio / Power Automate / Telegram / Graph)
- `public/index.html` — dashboard HTML single-page (KPIs, tooltips, feed leads, réponses)
- `programmes.json` — mapping des programmes avec accroches personnalisées
- `inboxWatcher.js` — module legacy de poll Graph direct (avant bascule sur reply watcher PA)
- `.env.example` — template des variables d'environnement
- `PLAN-WHATSAPP-PROD.md` — plan de migration WhatsApp sandbox → prod Meta
- `TESTS.md` — cheat-sheet des commandes de test et d'inspection
- `REPRISE-AU-REVEIL.md` — debrief de la session du 6 mai (historique, partiellement obsolète)
- `INCIDENT-2026-05-06.md` — récap incidents matin/après-midi du 6 mai
- `guide-power-automate.docx` / `guide-azure-ms365.docx` — procédures pas-à-pas

---

## Roadmap courte

- [x] Pipeline email T+24h via Power Automate
- [x] Notif interne email après envoi
- [x] Persistance `/data` sur Railway
- [x] Endpoints de test
- [x] Instant envoi sur certains programmes (`INSTANT_PROGRAM_IDS`)
- [x] Exclusion de programmes (`EXCLUDED_PROGRAM_IDS`)
- [x] Skip leads dénoncés (check 3 conditions sur le lead)
- [x] WhatsApp prod Meta via ContentSid templates
- [x] Cadence J+3 matin (3 jours d'escalation)
- [x] Cadence J+15 (3 jours d'escalation)
- [x] Fenêtre d'envoi 9h–20h Paris + blocage dimanche
- [x] Notifications Telegram (canal urgent)
- [x] Webhook réponses prospect (mail via PA + WhatsApp via Twilio)
- [x] Statut `denounced` séparé dans `/api/stats`
- [x] Métriques WhatsApp dans `/api/stats`
- [x] Dashboard : tooltips KPI + KPI Réponses WhatsApp + cache programId→name
- [ ] Route `PATCH /leads/{id}` côté Adlead (annoncée été 2026) — passage statut `pending` automatique
- [ ] Reply handler complet (Graph + Claude) en prod — actuellement pilote derrière `REPLY_HANDLER_ENABLED=false`
- [ ] Alerting auto (Discord/Telegram) sur taux d'erreur > seuil ou service down
- [ ] Webhook retour Outlook Booking pour marquer "RDV pris" dans Adlead
