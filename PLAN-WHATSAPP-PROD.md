# Plan de migration WhatsApp : Sandbox Twilio → Production Meta

Ce document décrit exactement les étapes pour passer du **sandbox Twilio** (phase 1, LIVE aujourd'hui) à la **prod WhatsApp Business avec templates Meta approuvés** (phase 2).

---

## Pourquoi migrer

Le sandbox est génial pour tester, mais il a deux murs qu'on ne peut pas franchir :

1. **Opt-in manuel obligatoire** — chaque destinataire doit envoyer `join fence-cutting` au +1 415 523 8886 avant qu'on puisse lui écrire. Impossible à faire sur des prospects chauds qui viennent juste de remplir un formulaire Adlead.
2. **Fenêtre de 24h** — même avec opt-in, Twilio sandbox bloque tout message envoyé plus de 24h après la dernière interaction client. Notre use-case (T+24h après un lead entrant) tombe pile sur la limite.

En prod Meta-approvée, on résout les deux : n'importe quel prospect peut recevoir un message **template-based** sans opt-in préalable (la politique WhatsApp considère que le prospect a "initié" la conversation en laissant ses coordonnées via un formulaire de ton site/annonce), et pas de contrainte de 24h sur les templates approuvés.

---

## Prérequis (le plus long)

### 1. Facebook Business Manager pour Catella
- URL : https://business.facebook.com
- Si Catella en a déjà un (demande au marketing), on l'utilise.
- Sinon : créer un Business Manager, ajouter le domaine catella.fr, vérifier l'entreprise via KBIS / adresse (processus Meta ~3-5 jours).

### 2. Vérification du business Meta (Business Verification)
- Dans Business Manager → Security Center → Start Verification
- Documents à avoir sous la main :
  - Kbis récent
  - Justificatif d'adresse au même nom
  - Numéro de téléphone pro (ligne fixe ou mobile pro Catella) qui peut recevoir un SMS/appel de vérif
- Délai : 24h à 5 jours selon l'équipe Meta qui review

### 3. Numéro de téléphone dédié WhatsApp
- **Règle clé** : ce numéro ne doit JAMAIS avoir été utilisé sur WhatsApp (ni perso ni business). Si un humain a déjà installé WhatsApp dessus, brûlé.
- **Options** :
  - (a) Acheter un numéro Twilio dédié (~1$/mois) via Twilio Console → Phone Numbers → Buy. France : numéro mobile +33 recommandé pour afficher "France" côté destinataire.
  - (b) Utiliser un numéro fixe Catella non-utilisé sur WhatsApp (attention au point "jamais utilisé").
- Coût indicatif pour Twilio : 1€/mois pour le numéro + ~0.005€ par message template sortant France→France.

### 4. Compte WhatsApp Business API via Twilio
- Dans Twilio Console → Messaging → WhatsApp → Senders → **Submit a WhatsApp sender**.
- Tu renseignes :
  - Le numéro dédié acheté à l'étape 3
  - Le nom affiché "Catella Residential" (limite 25 caractères)
  - Catégorie "Real Estate" ou "Finance & Banking"
  - Logo Catella carré 640×640 PNG (fond blanc, moins de 5 Mo)
- Meta review : 2-5 jours.

---

## Les templates à soumettre

Il faut soumettre **au moins 1 template** pour le use-case de relance T+24h. On peut en prévoir 2-3 pour avoir de la flexibilité.

### Template #1 : Relance après demande d'info (principal)
- **Nom interne** : `catella_relance_j1` (en minuscules, snake_case, obligatoire)
- **Catégorie Meta** : `MARKETING` (c'est une relance commerciale — ne pas mettre UTILITY, risque de refus)
- **Langue** : `fr`
- **Corps** :
```
Bonjour {{1}},

Je suis Norman DADON chez Catella Residential. Vous avez consulté notre programme {{2}} à {{3}} et je voulais savoir si vous souhaitiez en discuter.

Je peux vous réserver un créneau de 15 min ici : {{4}}

Belle journée,
Norman
```
- Variables :
  - `{{1}}` = prénom du contact
  - `{{2}}` = nom du programme (ex: LE 11 POITOU)
  - `{{3}}` = ville du programme
  - `{{4}}` = lien de prise de RDV (BOOKING_URL)
- **Pas de bouton cliquable** dans la V1 (Meta review plus rapide sans boutons). On pourra ajouter un bouton "Prendre RDV" qui ouvre l'URL en V2.

### Template #2 (optionnel) : Relance prospect "froid" J+7
Même structure, message plus léger, pour les prospects qui n'ont pas réagi à la première relance. Facultatif pour le go-live.

### Template #3 (optionnel) : Confirmation RDV pris
En catégorie `UTILITY` cette fois (c'est un message transactionnel de confirmation). Utile quand tu brancheras Outlook Booking → webhook sur prise de RDV.

---

## Modifications code nécessaires côté `server.js`

Aujourd'hui, `sendWhatsAppViaTwilio()` envoie un body libre :
```js
const form = new URLSearchParams();
form.set('From', CONFIG.TWILIO_WHATSAPP_FROM);
form.set('To', `whatsapp:${toE164}`);
form.set('Body', body);  // ← texte libre
```

En prod Meta, il faut remplacer par un template :
```js
const form = new URLSearchParams();
form.set('From', CONFIG.TWILIO_WHATSAPP_FROM);
form.set('To', `whatsapp:${toE164}`);
form.set('ContentSid', CONFIG.TWILIO_TEMPLATE_RELANCE_J1);  // SID du template approuvé
form.set('ContentVariables', JSON.stringify({
  1: contact.firstname || 'Bonjour',
  2: programName,
  3: ville || '',
  4: CONFIG.BOOKING_URL,
}));
```

Et ajouter 1 variable d'env :
- `TWILIO_TEMPLATE_RELANCE_J1` = le SID du template (format `HXxxxxxxxxx...`), copié depuis Twilio Console après approbation Meta.

---

## Checklist go-live prod

À faire dans l'ordre :

- [ ] Business Manager Catella créé / récupéré
- [ ] Business vérifié (tick vert dans Security Center)
- [ ] Numéro Twilio dédié acheté
- [ ] WhatsApp Sender soumis dans Twilio Console
- [ ] WhatsApp Sender approuvé par Meta (mail de Twilio)
- [ ] Template `catella_relance_j1` rédigé en FR
- [ ] Template soumis dans Twilio Console → Content Template Builder
- [ ] Template approuvé par Meta
- [ ] SID du template copié
- [ ] Variable `TWILIO_TEMPLATE_RELANCE_J1` ajoutée sur Railway
- [ ] Variable `TWILIO_WHATSAPP_FROM` mise à jour (nouveau numéro)
- [ ] Code `sendWhatsAppViaTwilio()` modifié pour utiliser `ContentSid` + `ContentVariables`
- [ ] Commit + push + Railway redéploie
- [ ] Test E2E : POST /api/test/process-now sur un lead réel avec ton propre numéro
- [ ] Vérifier arrivée WhatsApp avec message formaté
- [ ] Vérifier dans Twilio Console que le statut passe à `delivered` puis `read`
- [ ] Observer 24h sur trafic réel avant de généraliser

---

## Coûts estimés (rythme actuel Catella)

Hypothèse : ~30 leads/jour → 30 WhatsApp/jour → ~900/mois.

- Numéro Twilio dédié : ~1€/mois
- Session initiée par business (template marketing) France : **~0.073€ par message** (tarif WhatsApp BSP juin 2025, à re-vérifier)
- Conversation utility (si on ajoute template confirmation) : ~0.024€ par message
- **Total estimé : ~65-70€/mois pour 900 relances.**

Reste largement rentable vs coût d'acquisition d'un lead immobilier neuf (souvent 50-200€) — dès qu'on rattrape 1 lead/mois qui aurait été perdu sans la relance WhatsApp, c'est ROI positif.

---

## Risques / pièges à connaître

1. **Template rejeté par Meta** : motifs fréquents — trop promotionnel ("meilleur prix !"), majuscules excessives, emoji dans des positions suspectes, URL raccourcie. Solution : reformulation + resoumission (gratuit mais nouvelle attente ~48h).
2. **Taux d'opt-out élevé** → Meta réduit la qualité de notre numéro → limite le nombre de messages/jour. Mitigation : cibler **uniquement** les leads qui ont explicitement donné leur numéro ET sont "chauds" (qualification scoring à mettre en place côté Adlead ou côté ce serveur).
3. **Numéro qui perd la certification** → on re-passe en review Meta. Garder le numéro sandbox comme backup pour ne pas couper la chaîne pendant ce temps.
4. **Contrainte RGPD** : mentionner dans la politique de confidentialité Catella que les coordonnées collectées peuvent être utilisées pour une relance WhatsApp. Voir avec la juriste Catella.

---

## Timeline réaliste

- Semaine 1 : Business Manager + vérification business (⏳ side-quest admin Catella)
- Semaine 2 : Achat numéro + submit WhatsApp Sender Twilio (~2-5 jours Meta review)
- Semaine 3 : Soumission template #1 + code side (Norman + Claude, 1 session)
- Semaine 4 : Test interne sur 5 leads pilote + observation Twilio Console
- Semaine 5 : Go-live complet + monitoring quotidien 7 jours

Budget temps honnête : **1h de Norman par semaine sur 5 semaines**, le reste c'est l'attente Meta.
