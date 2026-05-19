# WhatsApp Prod Meta — État au 20 mai 2026

## Status global

| Composant | État |
|---|---|
| 🔢 Numéro Twilio dédié `+1 385 332 4609` | ✅ **Approuvé Meta** — `TWILIO_WHATSAPP_FROM=whatsapp:+13853324609` sur Railway |
| 📝 Template `relance_j1_catella` | ✅ **Approuvé Meta** — `TWILIO_TEMPLATE_RELANCE_J1=HX1e7f179526b97844b6576c68af2b35b7` sur Railway |
| 🔌 Code `sendWhatsAppViaTwilio` (ContentSid) | ✅ **En place** — bascule auto en mode ContentSid si variable présente |
| 🔁 Webhook réponses prospect `/webhook/whatsapp-incoming` | ✅ Codé |
| ❎ Désactivation sender test `+1 555 873 4459` | ⚠️ À faire après E2E validé sur nouveau numéro |

## Identifiants importants à conserver

### Meta Business Manager (BM) "Catella Residential"
- **BM ID** : `2023707208234565`
- URL Settings : https://business.facebook.com/latest/settings/business_info/?business_id=2023707208234565

### WhatsApp Business Account (WABA) "Catella Residential"
- **WABA ID** : `1648723969512937`
- URL Numéros : https://business.facebook.com/wa/manage/phone-numbers/?business_id=2023707208234565&waba_id=1648723969512937

### Numéros sur la WABA
| Numéro | Statut Meta | Rôle |
|---|---|---|
| `+1 555 873 4459` | Connecté (test Meta) | Actuel — limite 5 msg/24h, expire 90j |
| `+1 385 332 4609` | En attente (review Meta) | **Cible** — numéro Twilio dédié $1.15/mois |

### Template Meta "relance_j1_catella"
- **ContentSid (Twilio)** : `HX1e7f179526b97844b6576c68af2b35b7`
- **Catégorie Meta** : Marketing
- **Langue** : French (fr)
- **Variables** : `{{1}}` = prénom, `{{2}}` = nom du programme
- **Sample values soumis** : `{{1}}=Jean`, `{{2}}=Les Panoramas - Cimiez`
- URL Twilio : https://console.twilio.com/us1/develop/sms/content-template-builder/template/HX1e7f179526b97844b6576c68af2b35b7

### Corps du template soumis
```
Bonjour {{1}},

Norman de chez Catella. Je fais suite à votre demande sur le programme {{2}}.

Je viens de regarder les disponibilités et il y a potentiellement des choses intéressantes pour vous. Que recherchez-vous comme type d'appartement actuellement ?

Je vous ai également envoyé un mail avec la brochure du projet.

Dans l'attente de vous lire.
Au plaisir,
Norman DADON

—
Catella Residential — Logement neuf
```

## Étapes à exécuter quand Meta a approuvé

### Quand le NUMÉRO `+1 385 332 4609` passe "Connecté" côté Meta

1. Côté Twilio, vérifier que le sender apparaît dans `WhatsApp Senders` avec status `Online` (synchro auto sous quelques minutes après passage "Connecté" Meta)
2. Récupérer le **Sender SID** (commence par `XE...`)
3. Sur Railway > Variables : remplacer `TWILIO_WHATSAPP_FROM=whatsapp:+15558734459` par `TWILIO_WHATSAPP_FROM=whatsapp:+13853324609`
4. Faire un test E2E en envoyant un WhatsApp via `POST /api/test/process-now` sur un lead réel
5. Une fois confirmé OK, désactiver le sender test `+1 555 873 4459` côté Twilio (Edit Sender > Deactivate) — libère la WABA du numéro test

### Quand le TEMPLATE `relance_j1_catella` passe "Approved" côté Meta

1. Côté Twilio, status passe de "Under Review" → "Approved" (visible sur https://console.twilio.com/us1/develop/sms/content-template-builder/template/HX1e7f179526b97844b6576c68af2b35b7)
2. Sur Railway > Variables : ajouter `TWILIO_TEMPLATE_RELANCE_J1=HX1e7f179526b97844b6576c68af2b35b7`
3. Coder dans `server.js` la fonction `sendWhatsAppViaTwilio` pour utiliser `ContentSid` + `ContentVariables` (au lieu du `Body` actuel qui ne marche que pour les sandbox-joined numbers) :
   ```js
   const params = new URLSearchParams({
     From: CONFIG.TWILIO_WHATSAPP_FROM,
     To: `whatsapp:${phone}`,
     ContentSid: CONFIG.TWILIO_TEMPLATE_RELANCE_J1,
     ContentVariables: JSON.stringify({ "1": firstname, "2": programName }),
   });
   ```
4. Garder un fallback `Body: text` si `TWILIO_TEMPLATE_RELANCE_J1` est vide (pour compatibilité tests)
5. Push + déploiement Railway + test E2E

## Notes

- Si Meta REJETTE le template : ajuster le wording (souvent il faut enlever des phrases promo trop appuyées, ou la promesse "intéressantes" qui peut passer pour engageant), puis "Duplicate" le template, modifier, resoumettre. Le SID change à chaque resoumission donc bien mettre à jour `TWILIO_TEMPLATE_RELANCE_J1`.
- Si Meta REJETTE le numéro : généralement c'est un problème de Business Verification (BM Catella pas verified) — il faudra completer la verification (documents corporates) avant de re-tenter.
- Quota envoi : tant que la BM n'est pas Business Verified par Meta, le quota max est de **1000 conversations/24h** (Tier 1). Une fois Business Verified, le quota grandit progressivement (Tier 2 = 10000, Tier 3 = 100000, Tier 4 = Unlimited) en fonction du volume + quality rating. Pour Catella la cible Tier 1 est largement suffisante au début.
