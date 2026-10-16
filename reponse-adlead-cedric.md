# Réponse à Cédric (Adlead) — défense du système custom + relance sur le 403

**À :** Cédric (Adlead)
**Objet :** Re: scopes API et automatisation — pourquoi système custom

---

Salut Cédric,

Merci pour le retour rapide — bonne nouvelle pour le 500 sur `POST /sales-actions`, on a retesté et ça répond en 200 avec une `id` correcte, c'est impeccable.

Sur ta question "pourquoi un système aussi complexe alors que les automatisations natives du CRM couvrent le besoin" — je comprends le réflexe, et c'est vrai que pour un simple "email J+1 en relance auto" tu as raison, les workflows natifs suffiraient largement. Mais notre pipeline fait plusieurs choses qui, à ma connaissance, ne sont pas couvertes en natif — ou alors j'ai manqué une option, auquel cas je suis preneur d'un pointeur :

1. **Double canal email + WhatsApp simultané** via Twilio (templates Meta approuvés en phase 2). Chaque lead chaud reçoit une relance mail ET un WhatsApp personnalisé dans la même passe.

2. **Reply handler IA** : quand le prospect répond au mail de relance, un moteur Claude (Anthropic) lit la réponse, classifie l'intention (intéressé / désintéressé / demande d'info / mauvais numéro…) et prépare un brouillon de réponse dans Outlook pour validation humaine. Ça nous fait gagner un temps considérable sur les retours.

3. **Merge de données enrichies par programme** : on a un référentiel maison (`programmes.json` — 30+ programmes) avec des accroches commerciales custom, le nom du promoteur, la ville, des arguments de vente spécifiques. Le template de relance merge tout ça avec la donnée lead. Je ne suis pas sûr que les workflows natifs permettent de charger un référentiel tiers comme ça.

4. **Branding Catella strict** : template HTML custom, sender `norman.dadon@catella.com` via notre tenant M365, signature avec notre lien Outlook Bookings pour RDV. On garde la main sur l'ensemble de l'expérience.

5. **Notifications internes + dashboard temps réel** : à chaque lead traité, je reçois un mail interne avec un résumé + lien vers la fiche Adlead. On a aussi un dashboard maison avec les stats (sent / cancelled / optout / denounced / WhatsApp) et un kill switch pour couper en 1 min si besoin.

6. **Règle métier sur les dénonciations** — c'est justement le point qui me bloque aujourd'hui (cf. ci-dessous).

Cela dit, ta remarque sur la sécurité m'intéresse. Si les automatisations natives sont plus sûres par construction, je suis complètement partant pour une démo rapide pour voir où positionner le curseur entre natif et custom — typiquement si le natif peut prendre en charge l'email + le check dénonciation, ça allègerait notre stack et on garderait le custom pour WhatsApp + reply handler IA.

---

**Sur le point 1 (le 403 `/registrations`) : j'ai besoin de précisions** parce qu'on est actuellement en fail-closed total côté notre pipeline (plus aucune relance ne part tant qu'on ne sait pas si les leads sont dénoncés).

Tu dis que la clé est "restreinte par utilisateur". Deux interprétations possibles :

- **(A)** la clé est émise au nom d'un utilisateur Adlead qui n'a pas le droit `registrations`. Dans ce cas : peut-on soit donner ce droit à l'utilisateur courant, soit émettre une clé rattachée à un utilisateur qui l'a ?
- **(B)** la clé n'accède qu'aux ressources "attribuées" à elle-même. Dans ce cas j'ai du mal à comprendre l'asymétrie : on reçoit bien les webhooks `interest:created`, on lit bien `GET /leads/{id}` en 200, mais `GET /programs/{id}/registrations` retourne 403. C'est quoi exactement la règle d'autorisation ici ?

L'objectif final c'est juste de savoir *si un lead est dénoncé* avant d'envoyer une relance. S'il existe un chemin plus simple que `/registrations` — un flag exposé sur `GET /leads/{id}`, un webhook `registration:created` auquel on pourrait s'abonner, ou toute autre approche — on est preneurs.

Merci pour le temps passé — dis-moi ce qui marche pour la démo / les précisions sur la clé.

Bien à toi,

Norman Dadon
Directeur des ventes — Catella
