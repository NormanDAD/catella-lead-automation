# Auth Microsoft Graph — 3 étapes

Le pilote "réponses prospect" a besoin d'accéder à ta boîte Outlook (norman.dadon@catella.com) pour :
- lire les réponses des prospects dans ton Inbox
- poser des brouillons de réponse dans ton dossier **Brouillons** (jamais d'envoi auto)

L'auth utilise le **device code flow** Microsoft : pas besoin d'app registration Azure AD, pas besoin de l'IT Catella. 2 minutes.

## Étapes

1. Ouvre dans ton navigateur :
   ```
   https://lead-automation-production-33e8.up.railway.app/api/auth/start
   ```

2. Une page s'affiche avec un bouton **"Ouvrir Microsoft"** et un code (`ABCDEFGH`). Clique le bouton, colle le code, connecte-toi avec `norman.dadon@catella.com`, approuve.

3. C'est fini. Le serveur a les tokens (access + refresh), les a persistés sur le Volume Railway, et va commencer à poller ta boîte toutes les 3 min.

## Vérifier que c'est bon

```
https://lead-automation-production-33e8.up.railway.app/api/auth/status
```

Doit renvoyer `{"authenticated": true, "accountEmail": "norman.dadon@catella.com", ...}`.

## Activer le poll

Le poll ne tourne que si `REPLY_HANDLER_ENABLED=true` dans les env vars Railway. Tant qu'il est `false`, Graph est auth mais rien n'est fait.

Env vars à setter côté Railway :
- `ANTHROPIC_API_KEY` — clé API Anthropic (pour la classification + rédaction)
- `REPLY_HANDLER_ENABLED` — `true` pour activer
- `REPLY_POLL_INTERVAL_MS` — optionnel, default `180000` (3 min)

## Si ça casse

- **Token expire ou tu révoques** : refais `/api/auth/start`. Le refresh token Microsoft dure 90 jours tant qu'il est utilisé.
- **Erreur dans les logs** : le pipeline de relance principal n'est **jamais** impacté — le reply handler est 100% isolé en try/catch.

## Sécurité

Le public client ID utilisé (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) est celui d'Azure CLI. Scopes demandés : `Mail.Read Mail.ReadWrite offline_access User.Read`. Tu pourras révoquer l'accès à tout moment depuis [myaccount.microsoft.com](https://myaccount.microsoft.com/) → Sécurité → Applications associées.
