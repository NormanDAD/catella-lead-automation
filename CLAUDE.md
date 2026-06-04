# Claude — contexte projet Lead Automation Catella

> Fichier chargé automatiquement à chaque session Claude Code dans ce repo.
> Garde dense et à jour. Si un point ici n'est plus vrai, corrige-le.

## En une phrase

Pipeline Node.js (sur Railway) qui reçoit les webhooks Adlead `interest:created`, attend, vérifie l'état du lead, et envoie des relances email (Power Automate) + WhatsApp (Twilio + templates Meta) selon 3 cadences. Dashboard public à `https://lead-automation-production-33e8.up.railway.app/`.

## Owner & contexte

- **Norman Dadon** (norman.dadon@catella.com) — fait tourner ça en solo pour son compte commercial Catella
- **Cédric** = contact côté Adlead (questions API, scopes, route `PATCH /leads`)
- Repo : `NormanDAD/catella-lead-automation` sur GitHub
- Pas de CI, pas de tests automatisés en CI. Railway auto-deploy sur push main.

## Architecture en 5 lignes

- `server.js` (~3700 lignes) = tout le backend Express : webhook, scheduler (tick 5 min), crons règles 2 et 3, helpers Adlead/Twilio/Power Automate/Telegram/Graph
- `public/index.html` = dashboard single-page (KPIs, feed, tooltips, réponses prospect)
- `programmes.json` = mapping nom de programme → accroche personnalisée (61 entrées, indexé par **nom**, pas par ID)
- `/data/` sur volume Railway = persistance (`pending_leads.json`, `processed_leads.json`, `program_name_cache.json`, `graph_token_cache.json`)
- Pas de DB. Tout en JSON sur disque.

## Les 3 cadences (essentiel à comprendre)

| Règle | Quand | État actuel | Kill switches |
|---|---|---|---|
| **R1 — J+1** | T+24h après webhook (ou immédiat pour `INSTANT_PROGRAM_IDS`) | **Auto-send ACTIVÉ** — le pipeline envoie automatiquement email + WhatsApp | `J1_AUTO_SEND_DISABLED=false` (variable absente = auto-send actif) |
| **R2 — J+3 matin** | Cron 9h15 Paris, scan des leads en statut Adlead `pending` depuis ≥24h, 3 jours d'escalation (email doux → WhatsApp template → email final) | **Actif en prod** (`J3M_SEND_DISABLED=false`) | `J3M_ENABLED`, `J3M_SEND_DISABLED`, `WHATSAPP_J3M_ENABLED` |
| **R3 — J+15** | Cron 10h Paris, scan des leads en stagnation `pending`, 3 jours d'escalation à J+15/+16/+17 sur `last_interaction_at` | Activé, mais `TWILIO_TEMPLATE_RELANCE_J15` vide (fallback email) | `J15_ENABLED`, `J15_SEND_DISABLED`, `WHATSAPP_J15_ENABLED` |

**Toutes les règles s'arrêtent dès que `lead.status ≠ "pending"`** (= prospect a répondu OU commercial a re-statué). Et toutes respectent la fenêtre 9h-20h Paris + blocage dimanche (`SEND_HOUR_START_PARIS` / `SEND_HOUR_END_PARIS`).

## Règles d'envoi — NE PAS MODIFIER (figées le 2026-05-28)

> Ces trois règles ont été définies et validées par Norman. Ne jamais les modifier sans validation explicite de Norman.
> Principe commun : avant chaque envoi, `fetchLead()` est appelé pour vérifier l'état réel du lead dans Adlead. Si le statut a changé, on n'envoie pas.
> Fenêtre commune : lundi–samedi, 9h–20h Paris. Dimanche bloqué toute la journée.

### Règle 1 — J+1 — NE PAS MODIFIER (figée le 2026-05-28)

Le pipeline envoie email + WhatsApp si ET SEULEMENT SI toutes ces conditions sont vraies :
1. `lead.is_under_prescription !== true` (sinon → `denounced`, priorité absolue)
2. `lead.status` est `to-process` OU `pending` (affecté mais non traité)
3. `interest.status` n'est pas dans les statuts actifs (`ongoing`, `to-follow`, `interested`, `negotiating`, `discarded`, `pending-purchaser`, `purchaser`)
4. `last_interaction_at` n'est PAS postérieur à `receivedAt` + 1 min (sinon → commercial a agi dans Adlead)
5. `lead.discard_reason` est null

Résumé : **`to-process` ou `pending` sans action commerciale → on envoie. Tout le reste → on n'envoie pas.**
Cette règle a été définie et validée par Norman le 2026-05-28 après incident. Ne pas la changer sans validation explicite.

### Règle 2 — J+3 — NE PAS MODIFIER (figée le 2026-05-28)

Déclenchement : cron 9h15 Paris, tous les jours sauf dimanche.
Condition d'éligibilité : `record.status === 'sent'` (J+1 a été envoyé) ET `lead.status === 'pending'` (toujours en attente de contact dans Adlead).
Référence de temps : `record.processedAt` uniquement (= date d'envoi J+1). Jamais `last_interaction_at`.
Séquence : 3 envois sur 3 jours consécutifs depuis J+3 — email doux → WhatsApp → email final.
Arrêt immédiat si `lead.status !== 'pending'` (prospect a répondu ou commercial a re-statué). Le compteur `j3mRelances` est alors réinitialisé.
Fenêtre : lundi–samedi 9h–20h Paris. Un lead skippé un dimanche est rattrapé le lundi.

### Règle 3 — J+15 — NE PAS MODIFIER (figée le 2026-05-28)

Déclenchement : cron 10h Paris, tous les jours sauf dimanche.
Condition d'éligibilité : `record.status === 'sent'` ET `lead.status === 'pending'` depuis ≥ 15 jours après `record.processedAt`.
Référence de temps : `record.processedAt` (= date d'envoi J+1).
Séquence : 3 envois sur 3 jours — email "je classe ton dossier" → WhatsApp → email final.
Arrêt immédiat si `lead.status !== 'pending'`.
Fenêtre : lundi–samedi 9h–20h Paris. Un lead skippé un dimanche est rattrapé le lundi.

## Templates email — NE PAS MODIFIER (figés le 2026-05-28)

Structure identique sur les 7 templates (J+1, J+3 ×3, J+15 ×3). Ne jamais modifier sans validation Norman.

**J+1 (`buildEmailBody`)** :
- Salutation : `buildSalutation(contact)` → `Monsieur/Madame Nom` ou fallback `Madame, Monsieur`
- Accroche : `stripAccrochePrefix(accroche, ville, promoteur)` — retire le préfixe "À [ville], … par [promoteur]" car déjà mentionné dans la phrase précédente. Résultat : l'accroche commence par le nom du programme.
- Brochure : bouton HTML `brochureButton(url)` dans le corps — lien vers `/brochures/slug.pdf` sur Railway. **Uniquement sur J+1.**
- Signature complète (nom, titre, adresse, tel, email, web).

**J+3 et J+15 (6 templates)** :
- Salutation : `buildSalutation(contact)` — même logique que J+1.
- Accroche : paragraph `<em>accroche</em>` (texte complet depuis `programmes.json`, sans strip — déjà cohérent en standalone).
- **Pas de brochure** (retirée volontairement le 2026-05-28).
- Signature courte (`Norman DADON — Catella Residential — Logement neuf`).

**`brochures.json`** : indexé par nom de programme (exact ou normalisé sans accents/casse). 34/58 programmes couverts. Les 24 sans PDF enverront l'email sans bouton brochure (silencieux, pas de skip).

## Check dénonciation (post-incident 2026-05-06)

Bloque l'envoi si **au moins une** des conditions ci-dessus (voir règle J+1).
L'ancien check via `/registrations` est désactivé par défaut (`SKIP_REGISTRATIONS_CHECK=true`) — clé API n'a plus le scope, et Adlead filtre à la source.

## Env vars critiques (Railway, pas .env local)

- **Adlead** : `ADLEAD_API_KEY` (clé #223), `ADLEAD_WEBHOOK_SECRET`, `ADLEAD_TENANT=catella`
- **Power Automate** : `POWER_AUTOMATE_URL` + `POWER_AUTOMATE_SECRET` (envoi mail prospect), `POWER_AUTOMATE_INBOX_SECRET` (webhook reply watcher)
- **Twilio** : `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, templates ContentSid (`TWILIO_TEMPLATE_RELANCE_J1`, `_J15`, `_J16`, `_J3M_DAY2`)
- **Telegram** : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (bot `@Catella_notif_bot`)
- **Kill switches** : `PIPELINE_DISABLED` (nucléaire), `WHATSAPP_ENABLED`, `INTERNAL_NOTIF_DISABLED`
- **Agent WhatsApp (réponse auto)** : `WHATSAPP_AUTO_REPLY_ENABLED` (default OFF). Quand `true` + `WHATSAPP_ENABLED` + `ANTHROPIC_API_KEY`, l'agent répond **automatiquement** au prospect qui écrit en WhatsApp (`/webhook/whatsapp-incoming`), **uniquement si le numéro est matché à un lead connu**. Texte généré par Claude (`inboxWatcher.draftWhatsAppReply`), ton Norman, garde-fous anti-invention (prix/dispo/juridique → pivot RDV Bookings), brochure partagée si dispo, historique conversationnel injecté. Norman reçoit une copie de chaque réponse auto (email + WhatsApp interne) et peut corriger. Désinscription/litige/sensible → l'agent s'abstient (`shouldReply=false`). Couper : `WHATSAPP_AUTO_REPLY_ENABLED=false`.
- **Listes** : `INSTANT_PROGRAM_IDS` (bypass T+24h), `EXCLUDED_PROGRAM_IDS`

Liste exhaustive et explications : voir `README.md` section "Variables d'environnement" et le bloc `CONFIG = { ... }` en haut de `server.js`.

## Endpoints à connaître

- `GET /api/health` — santé + flags des règles
- `GET /api/stats` — agrégats dashboard
- `GET /api/leads`, `/api/pending`, `/api/dashboard/replies`
- `POST /api/scheduler/run` — force un tick
- `POST /api/test/process-now` — traite 1 lead immédiatement (body `{leadId, programId, force}`)
- `POST /api/admin/resolve-program-names` — résout les `Programme #XXX` via Adlead (peuple le cache)
- `POST /api/admin/backfill-program-names` — rétrofitte le programName des vieux records depuis le cache
- `POST /webhook/adlead`, `/webhook/inbox-reply`, `/webhook/whatsapp-incoming`

Liste complète : `README.md` section "Endpoints".

## Gotchas (= choses qui ont déjà mordu)

1. **`programNameCache` est en mémoire** mais désormais persisté dans `/data/program_name_cache.json` (commit `814853c`). Avant ce commit, chaque redeploy le vidait → leads skip silencieusement faute de nom.
2. **`programmes.json` est indexé par nom de programme** (pas par ID). Si le cache résout un nom qui n'est pas une clé dans `programmes.json`, le lead est skip (faute d'accroche).
3. **Webhook `/webhook/inbox-reply` retourne `matched: 'true'/'false'` en STRING** (pas booléen) — compat condition Power Automate.
4. **Reply Watcher passe par Power Automate**, pas par Graph direct. Raison : la Conditional Access policy de Catella bloque l'auth Graph depuis l'IP serveur Railway (le serveur n'est pas un device Catella enregistré). Voir `POWER_AUTOMATE_INBOX_SECRET`.
5. **`PATCH /leads/{id}` côté Adlead n'existe pas encore** (annoncé été 2026 par Cédric). Le code tente quand même, récupère 405 silencieusement. `STATUS_UPDATE_ENABLED=true` par défaut, mettre à `false` si les logs polluent.
6. **Sales-action Adlead renvoie 500** — connu, ignoré. Remplacé par pose de tag (qui marche, gated par `TAG_UUID_RELANCE_J1`).
7. **Dry-run J+15 envoyait pour de vrai** avant le commit `63bcedf` du 13 mai — d'où `J15_SEND_DISABLED` belt-and-suspenders. Toujours vérifier que les "dry-run" sont vraiment dry.
8. **`/api/stats` `today` ≠ `byDay[aujourd'hui]`** — fuseaux horaires différents quelque part. Vérifier les deux.

## Workflow standard

- **Modifier le code** : édit local → `git add` + `commit` + `push origin main` → Railway redeploy auto (~1 min)
- **Modifier une env var** : Railway Dashboard → Variables → Apply → Deploy
- **Couper en urgence** : `PIPELINE_DISABLED=true` (scheduler off, webhook continue à encaisser)
- **Vérifier un lead** : `GET https://lead-automation-production-33e8.up.railway.app/api/leads` ou dashboard

## Fichiers de référence

- `README.md` — la doc utilisateur, à jour au 2026-05-19 (commit `fe29556`)
- `programmes.json` — accroches par programme
- `inboxWatcher.js` — module legacy (poll Graph direct), plus utilisé en prod (remplacé par webhook PA)
- `INCIDENT-2026-05-06.md` — récap du double incident (clé API rejetée + dénonciations mal filtrées)
- `PLAN-WHATSAPP-PROD.md` — migration sandbox → prod Meta (largement terminé)
- `TESTS.md` — cheat-sheet curl
- `REPRISE-AU-REVEIL.md` — debrief du 6 mai (historique, en partie obsolète)
- `guide-power-automate.docx` / `guide-azure-ms365.docx` — procédures Office (non commitées, locales)

## Conventions de commit observées dans `git log`

Format conventional commits français : `feat:`, `fix:`, `docs:`, `chore:` avec scope optionnel (`feat(dashboard):`, `fix(j15):`, `feat(rules-2-3):`). Sujet court, corps explicatif si nécessaire. Co-author Claude OK si la session a aidé.
