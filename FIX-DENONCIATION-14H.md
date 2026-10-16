# Fix filtre "skip leads dénoncés" — à déployer à 14h

## TL;DR
Le fix est déjà écrit dans `server.js` (changements non committés à cause d'un verrou `.git/index.lock` côté sandbox). Il te reste à :

```bash
cd ~/Desktop/lead-automation
rm -f .git/index.lock         # tuer le verrou laissé par le sandbox
git add server.js
git commit -m "fix(dénonciation): matcher tolérant sur lead_id/leadId/lead.id + logs + endpoint dump"
git push origin main
```

Railway redéploie tout seul sur push.

## Vérification après déploiement (30 sec)

1. Ouvre `https://lead-automation-production-33e8.up.railway.app/api/test/registrations-dump?programId=611&leadId=1633940`

   Regarde `firstRegistrationKeys` dans la réponse — c'est la liste EXACTE des champs d'une registration Adlead. Si tu vois `lead_id` présent, le matcher existant marchait et la cause est ailleurs (pagination ou registration absente). Si tu vois `leadId` ou `lead` (objet), on a trouvé le bug : l'ancien code cherchait `r.lead_id` qui était `undefined` → `Number(undefined) = NaN` → **jamais** de match → filtre silencieusement inopérant.

2. Vérifie aussi `matchingForLead` : si ça contient un objet avec `status: "approved"` non expiré ou `status: "pending"`, le lead 1633940 AURAIT dû être bloqué.

3. Dans les logs Railway tu verras désormais systématiquement une ligne `[registrations] programme X / lead Y: N reg(s) total, M match lead — schema keys du premier: ...` qui rend le filtre observable.

## Contexte du lead qui est passé
- **Lead 1633940** sur **programme 611 (Cristallerie, Sèvres)**
- Email envoyé à `alicemaillet85@gmail.com` le 22/04 à 10:37:45
- Appel Adlead `GET /programs/611/leads/1633940` montre : `status: "ongoing"`, `temperature: "warm"`, `discard_reason: null` — pas de flag évident au niveau du lead lui-même
- Les logs Railway pour cette requête ne montrent AUCUN `[process] … DÉNONCÉ` → le filtre a exécuté sans trouver de match

## Ce qui change dans le code

### `findActiveRegistrationForLead` (server.js ~l.385)
- Avant : `Number(r.lead_id) !== leadIdNum` — une seule forme de champ
- Après : `extractLeadIdFromRegistration(r)` — couvre `lead_id`, `leadId`, `lead.id`, `lead` direct, `lead_uid`, `lead_ref`
- Ajout de logs systématiques : nombre de regs, nombre de matchs, clés du schéma

### Nouveau endpoint `/api/test/registrations-dump`
Dump brut pour vérifier le schéma Adlead post-déploiement.

## Si après le push le lead passe encore…
Les nouveaux logs te diront exactement pourquoi :
- `0 reg(s) total` → problème de permissions API ou d'URL
- `N reg(s) total, 0 match lead` → champ lead pas dans ceux testés, faut regarder `schema keys du premier` et ajouter la variante dans `extractLeadIdFromRegistration`
- `N reg(s) total, M match lead` + pas de `DÉNONCÉ` → toutes les regs sont `rejected` ou `expired` → la dénonciation n'est pas active au sens Adlead → c'est un faux négatif côté données, pas côté code
