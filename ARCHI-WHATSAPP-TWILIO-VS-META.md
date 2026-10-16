# Architecture WhatsApp — Twilio (avant) vs Meta Cloud API direct (après)

> Note technique pour expliquer la migration de l'envoi/réception WhatsApp du pipeline de relances Catella.
> Repo `lead-automation`, tout est dans `server.js`. Migration réalisée le 2026-06-26, Twilio décommissionné le 2026-07-06.

---

## 1. Le problème qu'on résolvait

Le pipeline envoie des relances WhatsApp automatiques aux prospects (J+1, J+3, J+15).
Avec **Twilio**, ces messages partaient d'un **numéro cloud loué chez Twilio** (`+1 385 332 4609`, un numéro US).
Conséquence bloquante : **ce numéro n'existe que côté serveur**. Norman ne pouvait ni voir ni répondre aux
conversations depuis son téléphone. Toute réponse prospect devait être gérée par un **bot auto-reply** côté serveur.

Objectif de la migration : que les prospects échangent avec le **vrai numéro pro de Norman**
(`07 82 28 83 20`), **visible et utilisable nativement dans l'app WhatsApp Business** sur son téléphone,
tout en gardant l'envoi automatique par l'API. C'est ce qu'on appelle la **coexistence** (même numéro sur l'app ET l'API).

---

## 2. Schéma comparatif

### AVANT — via Twilio (BSP intermédiaire)

```
   Prospect (WhatsApp)
        │  ▲
        ▼  │
  ┌───────────────────────────────────────────┐
  │ Numéro CLOUD Twilio  +1 385 332 4609       │  ← loué chez Twilio, invisible du tél de Norman
  └───────────────────────────────────────────┘
        │  ▲
        ▼  │   REST  api.twilio.com/.../Messages.json   (Auth Basic : AccountSID:AuthToken)
  ┌───────────────────────────────────────────┐
  │ TWILIO  (BSP / proxy)                      │  ← intermédiaire : relaie vers Meta, prend une marge
  └───────────────────────────────────────────┘
        │  ▲
 sortant│  │ entrant (POST form-urlencoded, signature HMAC-SHA1)
        ▼  │
  ┌───────────────────────────────────────────┐
  │ server.js (Railway)                        │
  │  • sendWhatsAppViaTwilio()                 │  → ContentSid "HX..." + ContentVariables
  │  • POST /webhook/whatsapp-incoming         │  → réponses prospect
  │  • POST /webhook/twilio-status             │  → statuts livraison (queued→sent→delivered→read)
  └───────────────────────────────────────────┘

  ❌ Norman ne voit RIEN nativement → un bot auto-reply était obligatoire pour répondre.
```

### APRÈS — via Meta Cloud API direct (coexistence Dualhook)

```
       Norman  ─── répond lui-même depuis son app WhatsApp Business (natif, sur son tél)
          │                                    │ "echo"
          ▼                                    ▼
   Prospect (WhatsApp)                  ┌──────────────────────────────────────────┐
        │  ▲                            │ Numéro PRO  07 82 28 83 20                 │
        ▼  │  ◄───────────────────────►│ COEXISTENCE : app native ET Cloud API      │
                                        │ sur le MÊME numéro                         │
                                        └──────────────────────────────────────────┘
        │  ▲
        ▼  │   REST  graph.facebook.com/v.../{PHONE_NUMBER_ID}/messages   (Auth Bearer token)
  ┌───────────────────────────────────────────┐
  │ META Cloud API  (Graph API, direct)        │  ← Meta facture directement, aucun proxy
  └───────────────────────────────────────────┘
        │  ▲
 sortant│  │ entrant (POST JSON, signature HMAC-SHA256)
        ▼  │
  ┌───────────────────────────────────────────┐
  │ server.js (Railway)                        │
  │  • sendWhatsAppViaMetaCloud()              │  → template JSON + params positionnels {{1}},{{2}}
  │  • POST /webhook/whatsapp-meta             │  → 3 types d'events : messages / echoes / statuses
  └───────────────────────────────────────────┘

  ┌───────────────────────────────────────────┐
  │ DUALHOOK  (Tech Provider loué, ~12 $/mois) │  ← onboarding coexistence UNIQUEMENT.
  └───────────────────────────────────────────┘     Hors du flux runtime : ne voit aucun message.

  ✅ Norman voit et répond nativement → le bot auto-reply n'est plus nécessaire (désactivé sur ce path).
```

---

## 3. Différences techniques, point par point

| Aspect | Twilio (avant) | Meta Cloud API (après) |
|---|---|---|
| **Rôle de l'intermédiaire** | Twilio = **proxy runtime** : chaque message transite par ses serveurs | Dualhook = **onboarding uniquement** (Tech Provider). Zéro proxy : on parle à Meta en direct |
| **Endpoint sortant** | `POST api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json` | `POST graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages` |
| **Auth sortant** | Basic (`base64(AccountSID:AuthToken)`) | Bearer (`Authorization: Bearer <META_WHATSAPP_TOKEN>`) |
| **Format sortant** | form-urlencoded, `ContentSid=HX...` + `ContentVariables={"1":..,"2":..}` | JSON, `template.name` + `components[0].parameters[]` positionnels |
| **Numéro** | Numéro cloud US Twilio, invisible du téléphone | **Vrai numéro pro** en coexistence (app native + API) |
| **Endpoint entrant** | `POST /webhook/whatsapp-incoming` (form-urlencoded) | `POST /webhook/whatsapp-meta` (JSON) |
| **Vérif. webhook** | Signature **HMAC-SHA1** (`x-twilio-signature`) | Handshake GET `hub.challenge` + signature **HMAC-SHA256** (`X-Hub-Signature-256`) |
| **Statuts livraison** | Webhook séparé `/webhook/twilio-status` | Inclus dans le même webhook (`value.statuses[]`) |
| **Réponses de Norman** | Impossibles nativement → bot auto-reply requis | Captées via **`message_echoes`** (Norman répond depuis l'app, l'écho est loggé) |
| **Facturation** | Meta **+ marge Twilio** par message + abonnement numéro (~1 $/mois) | Meta **en direct** + Dualhook (~12 $/mois) + eSIM (~2 $/mois) |

---

## 4. Comment c'est construit côté code (le point important)

La migration **n'est pas une réécriture** : c'est un **changement de "driver" derrière une interface stable**
(pattern Strategy / Adapter). Trois couches :

### a) Deux implémentations bas niveau, une par provider
- `sendWhatsAppViaTwilio(toE164, body, { templateSid, contentVariables })` — parle à l'API Twilio.
- `sendWhatsAppViaMetaCloud(toE164, { templateName, bodyParams, text })` — parle à Graph API Meta.
  - Deux modes : **template** (relances cold, hors fenêtre 24 h) ou **texte libre** (session ouverte, ex. auto-reply).

### b) Un dispatcher qui choisit selon UN flag
```js
async function sendWhatsApp(toE164, body = '', options = {}) {
  if (CONFIG.WHATSAPP_PROVIDER === 'meta') {
    if (options.meta && options.meta.template)
      return sendWhatsAppViaMetaCloud(toE164, { templateName: options.meta.template, bodyParams: options.meta.params || [] });
    return sendWhatsAppViaMetaCloud(toE164, { text: body });   // session libre
  }
  return sendWhatsAppViaTwilio(toE164, body, options);          // legacy
}
```
Le provider est piloté par la variable d'environnement `WHATSAPP_PROVIDER` (`twilio` | `meta`).
**Bascule = 1 variable. Rollback = 1 variable.** Aucun redéploiement de code nécessaire pour switcher.

### c) Les 4 points d'envoi de relance n'ont pas changé
Les call-sites (J+1, J+1 retry, J+3 jour 2, J+16) appellent tous `sendWhatsApp(...)`.
Pour rester rétro-compatible, on a **gardé** le format d'options Twilio (`templateSid`, `contentVariables`)
et **ajouté** `options.meta = { template, params }`. Le dispatcher pioche celui qui correspond au provider actif.
Exemple (relance J+1) :
```js
const resp = await sendWhatsApp(phoneE164, body, {
  templateSid: CONFIG.TWILIO_TEMPLATE_RELANCE_J1,              // utilisé si provider=twilio
  contentVariables: { "1": firstname, "2": programName },
  meta: { template: 'relance_j1_catella', params: [fullname, programName] },  // utilisé si provider=meta
});
```

### d) La logique métier est identique quel que soit le provider
Réception d'une réponse prospect → **même traitement** dans les deux mondes :
1. **Match du lead** par numéro de téléphone (parcours des leads `status=sent`).
2. **Sales-action Adlead** posée → le lead "bouge" → **les relances J+1/J+3/J+15 s'arrêtent** automatiquement.
3. **Persistance** pour le dashboard, **idempotence** par identifiant de message (pas de doublon).

La nouveauté propre à la coexistence : le webhook Meta gère **3 types d'events** en un seul flux —
`messages` (prospect → nous), `message_echoes` (Norman répond depuis son app → on garde l'historique),
et `statuses` (accusés de livraison).

---

## 5. État final (2026-07-06)

- **Envoi + réception live = 100 % Meta Cloud API** (`WHATSAPP_PROVIDER=meta`).
- **Twilio décommissionné** : creds de connexion retirées de la prod (Railway). Le code Twilio reste
  présent mais **dormant** (jamais atteint tant que `WHATSAPP_PROVIDER=meta`).
- Reste à faire côté console Twilio (hors code) : libérer le numéro US, révoquer le token, fermer le compte.

**À retenir pour un non-initié** : on est passés d'un **intermédiaire qui relayait nos WhatsApp depuis un
numéro fantôme** à un **branchement direct sur Meta, sur le vrai numéro pro visible dans l'app de Norman** —
sans réécrire le pipeline, juste en changeant la « prise » derrière une interface commune.
