# Mail à envoyer à Adlead

**À :** support Adlead / contact commercial
**Objet :** Tenant catella — scopes API manquants et endpoints en erreur (automatisation des relances)

---

Bonjour,

Nous avons développé côté Catella une automatisation de relance des leads Adlead (webhook `interest:created` → relance email J+1 si le commercial n'a pas agi). Trois blocages nous empêchent aujourd'hui d'exploiter pleinement l'API v1 :

### 1. `GET /api/v1/catella/programs/{id}/registrations` → **403 Forbidden**

Notre clé serveur ne peut pas lister les dénonciations d'un programme, donc l'automatisation ne peut pas détecter si un lead est dénoncé avant de déclencher la relance — risque métier majeur (on relancerait un lead revendiqué par un prescripteur).

Réponse actuelle :
```json
{ "success": false, "message": "403 Forbidden" }
```

**Demande :** ajouter le scope `registrations:read` sur notre clé API tenant `catella`.

Idéalement aussi le scope `records:read` sur `GET /programs/{pid}/leads/{lid}/records` (même souci — 404 avec notre clé, alors que cet endpoint contient le record `event: "registration"` qui serait encore plus direct pour détecter une dénonciation).

### 2. `POST /api/v1/catella/programs/{pid}/leads/{lid}/sales-actions` → **500 Internal Server Error**

Systématiquement 500 sur tous nos appels, y compris avec un body strictement conforme à la doc <https://docs.adlead.immo/v1/salesActions.html> :

```json
{
  "type": "send-email",
  "scheduled_at": "2026-04-22T15:00:00.000000Z",
  "priority": "medium",
  "comment": "Traité — Relance automatique J+1 envoyée le 22/04/2026"
}
```

On souhaite pouvoir **poser automatiquement une sales-action** après l'envoi de la relance (pour que le commercial voie dans la timeline Adlead que le lead a été contacté).

**Demande :** identifier la cause du 500 (besoin d'un champ supplémentaire ? valeur d'énumération différente ? permission manquante ?) ou clarifier le format attendu.

### 3. Modification du statut d'un lead — **aucun endpoint documenté**

La doc v1 <https://docs.adlead.immo/v1/leads.html> n'expose que `GET` et `POST` sur `/leads` ; `PUT /leads/{id}` renvoie 500 et `PATCH /leads/{id}` n'est pas reconnu.

On souhaite pouvoir **mettre à jour le statut d'un lead via l'API** après traitement (passer par exemple de `ongoing` à un statut de suivi custom, ou marquer un lead comme traité/à qualifier).

**Demande :** exposer un endpoint `PATCH` ou `PUT` sur `/programs/{pid}/leads/{lid}` permettant au minimum de modifier :
- `status`
- `temperature`
- `follow_reason` / `discard_reason`

(Ou confirmer s'il existe déjà un endpoint que nous aurions manqué.)

---

**Contexte / urgence :** en attendant le point 1, nous avons mis en place un fail-closed qui bloque toute relance automatique tant que l'endpoint `/registrations` est inaccessible. Aucun risque côté prescripteurs donc, mais nos relances sont à l'arrêt.

Merci d'avance,

Norman Dadon
Directeur des ventes — Catella
norman.dadon@catella.com
