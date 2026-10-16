# Plan & checklist — WhatsApp coexistence sur numéro pro dédié (Option B)

> Objectif : faire en sorte que les prospects échangent avec un **numéro pro à Norman**,
> visible **nativement dans l'app WhatsApp Business sur son téléphone**, tout en gardant
> l'**auto-reply du bot** via l'API. Le numéro perso (`+33664…`) reste 100 % privé.
>
> Mécanisme : **Coexistence** (Meta, depuis mai 2025) = un même numéro sur l'app
> WhatsApp Business **et** sur le Cloud API simultanément.
>
> ⚠️ Twilio ne supporte pas la coexistence → on migre l'intégration de **Twilio vers
> Meta Cloud API direct**. Le numéro Twilio actuel reste en backup tant que la bascule
> n'est pas validée.
>
> Légende : 👤 = action Norman · 🔧 = action dev (Norman + Claude) · ⏳ = délai Meta

---

## Phase 0 — La ligne pro (côté Norman) — ~1-2 jours

- [ ] 👤 Vérifier que le téléphone gère l'eSIM (Réglages → « eSIM » / « Ajouter un forfait »).
      iPhone XS/XR+, Pixel 3+, Galaxy S20+ → OK.
- [ ] 👤 Commander un **forfait mobile FR avec eSIM, sans engagement**, numéro **neuf** :
      - Reco budget : **Free Mobile 2 €/mois** (la data de cette ligne est quasi inutile,
        voir note dual SIM ci-dessous) — ou **Lebara 5,99 €/50 Go** si on veut du confort.
      - Exigences : vraie ligne `+33 6/7` qui **reçoit les SMS** (PAS une eSIM data-only
        de voyage type Airalo/Holafly → inutilisable pour la vérif WhatsApp).
      - Numéro **neuf** (pas de portabilité d'un numéro ayant déjà servi sur WhatsApp).
      - Un numéro qu'on **garde longtemps** (en changer = re-onboarding + perte de continuité).
- [ ] 👤 Activer l'eSIM (scan du QR opérateur) → 2ᵉ ligne active sur le téléphone.
- [ ] 👤 Laisser la **ligne perso comme ligne data** par défaut (la ligne pro n'a pas besoin
      de data : WhatsApp Business utilisera la data perso / le Wi-Fi).

> **Note dual SIM** : une seule ligne porte la data à la fois. La ligne pro sert juste à
> héberger le numéro (vérif SMS + rester active). D'où le forfait à 2 € suffisant.

## Phase 1 — WhatsApp Business sur le numéro pro (côté Norman) — ~30 min

- [ ] 👤 Installer l'app **WhatsApp Business** (≠ WhatsApp grand public).
- [ ] 👤 L'activer sur le **numéro pro** (vérif par SMS reçu sur l'eSIM).
- [ ] 👤 Configurer le profil : nom « Catella Residential », photo/logo, description, horaires.
- [ ] 👤 Envoyer/recevoir 1-2 messages de test pour « réchauffer » le numéro.

> À ce stade : tu as déjà un WhatsApp Business pro fonctionnel sur ton téléphone, séparé
> de ton WhatsApp perso. La suite branche l'API par-dessus, sans rien casser.

## Phase 2 — Setup Meta Cloud API (🔧, côté dev/admin) — ⏳ 2-5 j (review Meta)

- [ ] 🔧 Accéder/créer le **Meta Business Manager** Catella (business.facebook.com).
- [ ] ⏳ **Business Verification** si pas déjà faite hors Twilio (Kbis + justif adresse).
- [ ] 🔧 Créer une **App Meta** (developers.facebook.com) + ajouter le produit **WhatsApp**.
- [ ] 🔧 Créer un **WABA propre** (le WABA actuel est hébergé par Twilio, on en fait un à nous).
- [ ] 🔧 Générer un **token système permanent** (System User) + récupérer `App Secret`.

## Phase 3 — Onboarding coexistence (👤 + 🔧) — ~15 min

- [ ] 🔧 Lancer l'**Embedded Signup** en mode coexistence côté app Meta.
- [ ] 👤 Dans WhatsApp Business → Réglages → **« Lier un appareil / API »** → scanner le QR
      de l'Embedded Signup. Choisir d'importer les **6 mois d'historique** si pertinent.
- [ ] ✅ Le numéro pro est maintenant sur l'**app Business ET le Cloud API** en même temps.

## Phase 4 — Migration du code Twilio → Meta Cloud API (🔧) — ~1 session

- [ ] 🔧 Nouveau helper `sendWhatsAppViaMetaCloud()` (POST `graph.facebook.com/v.../messages`),
      même interface que `sendWhatsAppViaTwilio()` pour garder les call-sites.
- [ ] 🔧 Nouveau webhook entrant `/webhook/whatsapp-meta` :
      - validation **`X-Hub-Signature-256`** (App Secret) au lieu de la signature Twilio,
      - parsing format Meta (`entry[].changes[].value.messages`),
      - endpoint de vérif GET (hub.challenge / `META_VERIFY_TOKEN`).
- [ ] 🔧 **Gestion de l'écho coexistence** : les messages que Norman envoie *à la main*
      depuis l'app arrivent aussi en webhook (sortants). Le code doit :
      - ne PAS les traiter comme un message entrant prospect,
      - **mettre le bot en veille sur ce fil** quand Norman répond lui-même
        (= « Norman a pris la main → auto-reply off »). Dédup avec l'auto-reply.
- [ ] 🔧 Supprimer le **ping WhatsApp interne** (`INTERNAL_NOTIF_PHONE`) — devenu inutile :
      les notifs internes passent déjà par **Telegram** (mis en place 2026-06-25).
- [ ] 🔧 Nouvelles env vars Railway : `WHATSAPP_PHONE_NUMBER_ID`,
      `WHATSAPP_BUSINESS_ACCOUNT_ID`, `META_WHATSAPP_TOKEN`, `META_APP_SECRET`,
      `META_VERIFY_TOKEN`. Garder les vars Twilio le temps du backup.

## Phase 5 — Templates Meta (🔧) — ⏳ 1-2 j (review Meta)

- [ ] 🔧 Recréer/soumettre sous le nouveau WABA : `catella_relance_j1`, `j16`, `j3m_day2`.
      Catégorie MARKETING, langue `fr`, variables `{{1}}` (prénom) / `{{2}}` (programme).
- [ ] ⏳ Attendre l'« Approved » Meta.

## Phase 6 — Pilote & go-live (🔧 + 👤) — ~1 semaine d'observation

- [ ] 🔧 Test E2E sur 5 leads réels (POST `/api/test/process-now`).
- [ ] 👤 Vérifier la réception côté prospect + que les fils apparaissent dans l'app Business.
- [ ] 👤 Vérifier qu'en répondant à la main, le bot se met bien en veille sur le fil.
- [ ] 🔧 Surveiller la **qualité du numéro** côté Meta Business Suite (signalements/blocages).
- [ ] 🔧 Bascule complète + monitoring quotidien 7 jours. Couper Twilio une fois validé.

## Phase 7 — Filets de sécurité (🔧)

- [ ] 🔧 **Alerte 14 jours** : Telegram « ⚠️ ouvre l'app WhatsApp Business » si X jours sans
      activité entrante sur le numéro (sinon Meta coupe la liaison API).
- [ ] 🔧 Kill switch : garder un flag pour repasser sur Twilio en urgence pendant la transition.

---

## Coûts

**Récurrent :**
- Ligne eSIM pro : ~2 €/mois (Free) à ~6 €/mois (Lebara).
- Messages Meta : auto-replies de **service** (réponse dans la fenêtre 24h) souvent
  **gratuits** ; seuls les **templates marketing** sortants (J+1/J+3/J+15) facturés
  (~0,07 €/msg France, à revérifier). Messages envoyés depuis l'app = gratuits.
- **Meta Verified** (optionnel, recommandé en Option B) : ~dizaine €/mois → nom « Catella »
  affiché + badge vert (sinon le prospect voit le numéro brut).
- Total probable : **≈ équivalent ou < aux ~65-70 €/mois actuels** (plus de markup Twilio,
  plus de location de numéro, service gratuit).

**One-time :**
- Dev : ~1 session (helper + webhook + coexistence/écho + env + templates).
- Temps Norman : ~1-2 h (commande eSIM, install Business, scan QR), reste = attente Meta.

**Délai bout-en-bout :** ~1,5 à 2 semaines, dominé par les reviews Meta, pas le dev.

---

## Points de vigilance

1. **Règle des 14 jours** : ouvrir l'app Business ≥ 1× / 14 j sinon coupure API (→ alerte Telegram Phase 7).
2. **Qualité numéro** : ciblage leads chauds / opt-in pour éviter les signalements qui
   dégradent les limites d'envoi (mais ici c'est une ligne pro isolée, pas la perso).
3. **RGPD** : mentionner l'usage WhatsApp dans la politique de confidentialité Catella (juriste).
4. **Numéro pérenne** : ne pas changer la ligne pro après coup (re-onboarding + perte de continuité).
5. **Carte prépayée à éviter** : une ligne qui expire couperait l'API → forfait mensuel classique.
