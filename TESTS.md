# Tests & incantations utiles — Lead Automation Catella

Ce document regroupe toutes les commandes de test et d'inspection qu'on utilise régulièrement pour vérifier la santé du pipeline. Garde-le sous la main.

URL de prod : `https://lead-automation-production-33e8.up.railway.app`

---

## 1. Vérifier que le serveur tourne

```bash
curl -s https://lead-automation-production-33e8.up.railway.app/api/health | jq
```

Ça doit renvoyer un JSON avec `status: "ok"`, les compteurs `pending`/`processed`, et l'état du volume persistant `/data`.

**Signaux d'alerte** :
- `persistence.writable: false` → le volume Railway est en lecture seule, les leads ne sont pas persistés → redémarrage = perte de file d'attente.
- `pendingFile.exists: false` → le fichier `pending_leads.json` a disparu → perte de file d'attente.
- `status != "ok"` → le serveur est en erreur.

---

## 2. Voir les leads traités

```bash
curl -s https://lead-automation-production-33e8.up.railway.app/api/leads | jq '.[0:5]'
```

Retourne la liste des leads traités (ordre récent → ancien). Les champs utiles :
- `status` : `sent` / `cancelled` / `optout` / `denounced` / `skipped` / `error`
- `whatsappEnabled`, `whatsappSid`, `whatsappError` : état de l'envoi WhatsApp
- `internalNotifError` : erreur éventuelle sur la notif interne
- `programName`, `email`, `subject` : contexte du lead

---

## 3. Voir les leads en file d'attente

```bash
curl -s https://lead-automation-production-33e8.up.railway.app/api/pending | jq 'length'
curl -s https://lead-automation-production-33e8.up.railway.app/api/pending | jq '.[] | {leadId, programId, checkAt}' | head -20
```

---

## 4. Forcer le traitement immédiat d'un lead (bypass fenêtre 24h)

**Cas d'usage** : tester que le pipeline complet fonctionne sur un lead réel sans attendre 24h.

```bash
curl -s -X POST "https://lead-automation-production-33e8.up.railway.app/api/test/process-now" \
  -H "Content-Type: application/json" \
  -d '{"leadId":"77143","programId":"686","force":"1"}' | jq
```

**Paramètres** :
- `leadId` : ID du lead dans Adlead (obligatoire)
- `programId` : ID du programme Adlead (optionnel — si absent, on fetch le lead et on prend le premier interest)
- `force: "1"` : bypass le check "commercial a pris la main" (utile si tu veux re-tester un lead déjà traité)

**À vérifier dans la réponse** :
- `result[0].status` doit être `sent`
- `result[0].whatsappSid` doit être présent si `WHATSAPP_ENABLED=true`
- Pas d'erreur dans `internalNotifError`

---

## 5. Déclencher un tick scheduler manuellement

**Cas d'usage** : tu veux que les leads en pending soient traités tout de suite plutôt qu'à la prochaine fenêtre 5 min.

```bash
curl -s -X POST https://lead-automation-production-33e8.up.railway.app/api/scheduler/run | jq
```

---

## 6. Tester uniquement les appels Adlead post-envoi

**Cas d'usage** : debug de la sales-action Adlead sans envoyer d'email.

```bash
curl -s -X POST "https://lead-automation-production-33e8.up.railway.app/api/test/adlead-update?programId=686&leadId=77143" | jq
```

Ça appelle `createRelanceSalesAction()` et `sendInternalNotif()`. La sales-action est connue pour échouer en 500 (API Adlead ne l'expose pas avec `X-API-Key`) — la notif interne doit réussir.

---

## 7. Probe des endpoints Adlead en lecture

**Cas d'usage** : vérifier quels endpoints de l'API Adlead répondent avec la clé API configurée.

```bash
curl -s "https://lead-automation-production-33e8.up.railway.app/api/test/adlead-probe?programId=686&leadId=77143" | jq
```

Retourne un tableau avec le statut HTTP de 6 endpoints candidats (GET lead, records, events, activities, sales-actions, interests).

---

## 8. Consulter /api/stats

```bash
curl -s https://lead-automation-production-33e8.up.railway.app/api/stats | jq
```

Agrégats pour le dashboard :
- `counts` : totaux par statut depuis le début
- `today`, `week` : fenêtres temporelles
- `byDay` : 14 derniers jours en buckets
- `byProgram` : nombre de leads par programme
- `recent` : 20 derniers leads (emails anonymisés)
- `whatsapp` *(après déploiement du patch)* : compteurs enabledLeads / sent / error

---

## 9. Observer les logs Railway en live

Depuis le dashboard Railway :
1. Ouvre le projet `lead-automation` → service `lead-automation`
2. Onglet **Logs**
3. Active "Follow" pour voir les nouveaux logs en temps réel

Patterns utiles à chercher :
- `[enqueue]` → un lead vient d'arriver via webhook
- `[scheduler]` → un tick vient de s'exécuter
- `[process] ✅ email envoyé` → succès email
- `[process] ✅ WhatsApp envoyé` → succès WhatsApp
- `[process] ⚠️ WhatsApp échec` → erreur WhatsApp (corps du message Twilio après `:`)
- `[process] D��NONCÉ` → un lead a été skippé par la règle dénonciation
- `[webhook] Signature invalide` → probleme de `ADLEAD_WEBHOOK_SECRET`

---

## 10. Simuler un webhook Adlead en local/staging

**Cas d'usage** : valider que le parseur webhook fonctionne sans attendre un vrai lead.

```bash
# 1. Calcul de la signature HMAC-SHA256 du body avec ADLEAD_WEBHOOK_SECRET
BODY='{"event":"interest:created","data":{"id":"test-123","lead_id":"77143","program_id":"686","status":"to-process"}}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$ADLEAD_WEBHOOK_SECRET" -hex | cut -d' ' -f2)

# 2. POST avec signature
curl -s -X POST https://lead-automation-production-33e8.up.railway.app/webhook/adlead \
  -H "Content-Type: application/json" \
  -H "X-Signature: sha256=$SIG" \
  -d "$BODY"
```

Si ça répond `{"message":"Reçu, en attente de traitement"}`, le webhook est bon.

---

## 11. Valider Twilio côté sandbox

Pour envoyer un WhatsApp manuel via sandbox (hors pipeline, pour debug pur Twilio) :

```bash
curl -s https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Messages.json \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  -d "From=whatsapp:+14155238886" \
  -d "To=whatsapp:+33TONNUMERO" \
  -d "Body=Test direct Twilio"
```

Tu dois recevoir le WhatsApp sur ton phone dans les 5 secondes (si tu as fait `join fence-cutting`).

Vérifier le statut d'un message par SID :
```bash
curl -s "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Messages/$SID.json" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" | jq .status
```

Statuts possibles : `queued` → `accepted` → `sending` → `sent` → `delivered` → `read`.

---

## 12. Checklist rapide après un redéploiement

Après un push vers `main` (Railway redéploie automatiquement) :

1. `curl .../api/health` → status `ok` ?
2. `curl -X POST .../api/test/process-now -d '{"leadId":"77143","programId":"686","force":"1"}'` → `status: sent` + `whatsappSid` présent ?
3. Regarder les logs Railway → pas d'erreur de démarrage ?
4. Ouvrir le dashboard → il se charge ?

Si les 4 sont OK, le déploiement est sain.
