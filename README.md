# Lead Automation — Catella

Automatisation des emails de qualification : **Adlead → Claude → Outlook**

Chaque nouveau lead dans Adlead déclenche automatiquement :
1. Récupération des détails du lead via l'API Adlead
2. Génération d'un email de qualification personnalisé par Claude
3. Envoi depuis ton adresse Outlook via Microsoft 365

---

## Déploiement sur Railway (15 min)

### Étape 1 — Préparer le code

```bash
# Dans le dossier du projet
npm install
```

### Étape 2 — Créer l'app Azure pour l'envoi d'emails

1. Va sur https://portal.azure.com
2. Cherche **"App registrations"** → New registration
3. Nom : `catella-lead-automation`, type : Single tenant
4. Clique sur ton app → **Certificates & secrets** → New client secret → copie la valeur
5. Va dans **API permissions** → Add permission → Microsoft Graph → Application permissions
6. Cherche et ajoute : `Mail.Send`
7. Clique **Grant admin consent**
8. Note les valeurs :
   - **Application (client) ID** → MS365_CLIENT_ID
   - **Directory (tenant) ID** → MS365_TENANT_ID
   - **Client secret value** → MS365_CLIENT_SECRET

### Étape 3 — Déployer sur Railway

1. Crée un compte sur https://railway.app
2. New Project → Deploy from GitHub (ou "Empty Project" + upload)
3. Dans les **Variables** de ton projet Railway, ajoute toutes les variables du fichier `.env.example`
4. Railway te donne une URL publique (ex: `https://xxx.railway.app`)

### Étape 4 — Configurer le Webhook dans Adlead

1. Dans Adlead → Paramètres → Webhooks
2. Ajoute l'URL : `https://xxx.railway.app/webhook/adlead`
3. Événement à sélectionner : **`interest:created`**
4. Copie le secret webhook fourni → colle-le dans `ADLEAD_WEBHOOK_SECRET` sur Railway

### Étape 5 — Obtenir ta clé Anthropic

1. Va sur https://console.anthropic.com
2. API Keys → Create Key
3. Colle la valeur dans `ANTHROPIC_API_KEY` sur Railway

---

## Dashboard

Une fois déployé, ouvre `https://xxx.railway.app` dans ton navigateur.
Tu verras en temps réel tous les leads traités, les emails générés, et les éventuelles erreurs.

---

## Structure du projet

```
├── server.js          # Backend principal (webhook + API + envoi email)
├── public/
│   └── index.html     # Dashboard de monitoring
├── package.json
└── .env.example       # Template des variables d'environnement
```
