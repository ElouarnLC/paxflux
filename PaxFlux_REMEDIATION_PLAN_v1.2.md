# PaxFlux — Plan de remédiation v1.2

**Baseline auditée :** `main` @ `1b2e60c06642f37911bcb766f8d343141ea18666`  
**Date :** 2026-08-30  
**Objectif :** transformer l’alpha actuelle en v1 exploitable sur le terrain sans réécrire inutilement le cœur métier.

---

## 1. Positionnement

PaxFlux ne doit pas être traité comme un dashboard CRUD générique. C’est un outil opérationnel de comptage de flux utilisé sous contrainte : téléphone, bruit, réseau instable, lumière extérieure, opérateurs non techniques, nécessité d’éviter les erreurs silencieuses.

La remédiation doit donc privilégier, dans cet ordre :

1. **exactitude métier et cycle de vie** ;
2. **fiabilité du parcours réel multi-appareils** ;
3. **résilience offline / reconnexion / QR** ;
4. **mobile-first et accessibilité** ;
5. **cohérence visuelle et design system** ;
6. **tests E2E et critères de production** ;
7. seulement ensuite les raffinements et nouvelles fonctionnalités.

Ce document remplace toute notion actuelle de « production-ready » tant que les critères d’acceptation de la section 13 ne passent pas.

---

## 2. Ce qui doit être conservé

Ne pas repartir de zéro. Conserver autant que possible :

- monorepo `packages/shared`, `apps/server`, `apps/web` ;
- Fastify, React, Vite, TypeScript ;
- SQLite en WAL et modèle single-process ;
- journal immuable des mouvements ;
- idempotence par `clientActionId` ;
- SSE pour le push temps réel ;
- Dexie / IndexedDB pour l’outbox ;
- sessions staff HttpOnly ;
- sessions appareil issues d’un QR à usage unique ;
- exports, sauvegardes, health endpoints ;
- Docker mono-conteneur ;
- modèle métier `event / space / checkpoint / movement / device_session`.

Toute modification d’un invariant ou d’une décision architecturale verrouillée doit être explicite, justifiée et documentée dans un ADR.

---

## 3. Défauts P0 à corriger

### P0-01 — Wizard événement non atomique et brouillons orphelins

**Symptôme :** le wizard crée l’événement en premier, puis les espaces/checkpoints, puis appelle `/start`. Toute erreur intermédiaire laisse un événement `draft` partiellement configuré.

**Correction cible :**

- supprimer l’auto-start implicite du wizard ;
- créer ou sauvegarder un brouillon cohérent ;
- naviguer vers une page de préparation `/admin/events/:id/setup` ;
- fournir un bouton explicite **Ouvrir le comptage** ;
- lancer un preflight serveur avant passage en `live` ;
- afficher les erreurs de topologie précisément ;
- rendre le draft éditable tant qu’il n’est pas live.

**Option préférée :** ajouter une API transactionnelle de création de brouillon complet, ou à défaut un endpoint `replace-topology` transactionnel pour le draft.

### P0-02 — Plusieurs portes/checkpoints non réellement configurables

**Symptôme :** le state contient un tableau `checkpoints`, mais l’UI ne manipule que `checkpoints[0]`.

**Correction cible :**

- ajouter/supprimer/réordonner plusieurs checkpoints ;
- choisir `spaceA` et `spaceB` pour chaque checkpoint ;
- configurer les deux directions indépendamment ;
- configurer `labelAToB` et `labelBToA` ;
- empêcher les endpoints topologiquement invalides ;
- afficher une prévisualisation lisible de la topologie.

Cas minimum à supporter :

- Extérieur ⇄ Site par Porte A ;
- Extérieur ⇄ Site par Porte B ;
- Extérieur ⇄ Site par Porte C ;
- Site ⇄ VIP ;
- Site ⇄ Salle A.

Plusieurs portes physiques doivent pouvoir relier la même paire d’espaces.

### P0-03 — Cycle de vie absent de l’admin

Créer une vraie surface de gestion d’événement avec actions contextuelles :

- `draft` → **Ouvrir le comptage** ;
- `live` → **Commencer la fermeture** ;
- `closing` → **Revenir en live** ou **Clôturer** ;
- `closed` → **Réouvrir** avec motif administrateur ou **Archiver** ;
- `archived` → lecture seule.

Chaque transition doit :

- vérifier les permissions ;
- demander confirmation si elle est sensible ;
- afficher le résultat ;
- invalider/refetch les queries ;
- être diffusée par SSE ;
- être testée E2E.

### P0-04 — Appareil QR incapable de compter quand l’événement reste draft

Le compteur doit présenter un état explicite par statut :

- `draft` : « Le comptage n’est pas encore ouvert » ;
- `live` : taps autorisés ;
- `closing` : **nouveaux taps interdits**, mais l’outbox existante continue de se vider ;
- `closed` / `archived` : lecture seule, aucune nouvelle action.

Ne jamais afficher un message disant « taps désactivés » si le code les autorise réellement.

### P0-05 — Bootstrap CSRF fragile après reload direct

Créer un **AuthProvider / StaffSessionProvider** au niveau racine.

Au démarrage de toute route admin :

1. charger `/api/v1/auth/session` ;
2. restaurer le CSRF en mémoire ;
3. exposer `user`, `role`, `csrfReady`, `authState` ;
4. ne rendre les routes mutantes qu’après bootstrap ;
5. rediriger proprement vers `/login` en cas de 401.

Supprimer la dépendance implicite au passage préalable par `/`.

### P0-06 — Heartbeat appareil manquant

Dans le compteur :

- POST `/api/v1/device/heartbeat` toutes les 15–20 secondes quand visible ;
- inclure `pendingCount`, `lastClientSequence`, `appVersion` ;
- heartbeat immédiat au focus / retour online ;
- suspendre ou ralentir en arrière-plan ;
- remettre l’appareil online dans le dashboard sans devoir compter.

### P0-07 — URL QR ambiguë / `localhost`

Ne pas reconstruire aveuglément le lien via `window.location.origin`.

Définir une source canonique :

- serveur : `PUBLIC_BASE_URL` si défini ;
- sinon origin courant seulement si publiquement joignable ;
- avertissement clair si hostname = `localhost`, `127.0.0.1` ou autre origin impropre au scan distant ;
- permettre d’afficher/copier une URL d’accès LAN détectée/documentée sans deviner silencieusement.

Le backend doit vérifier que `checkpointId` appartient bien à `eventId` avant de créer une invitation.

### P0-08 — Projection optimiste incorrecte pour transferts internes

Supprimer le `isSpaceBLeaf = true` codé en dur.

La projection locale doit appliquer une règle de conservation :

- externe → leaf : global +1 ;
- leaf → externe : global -1 ;
- leaf A → leaf B : global 0, A -1, B +1 ;
- inverse pour une reversal.

Le cache bootstrap doit contenir suffisamment de topologie pour calculer cette projection sans approximation.

### P0-09 — Cache offline incohérent

Unifier le snapshot persistant.

Éviter deux clés divergentes (`bootstrap_config.lastState` vs `last_server_state`).

Préférer :

- `device_config` : configuration stable du checkpoint ;
- `event_state` : dernier snapshot serveur ;
- `outbox_actions` : mutations non confirmées ;
- `meta` : séquences et version applicative.

Au démarrage offline : charger config + dernier état + outbox, puis calculer la vue optimiste.

### P0-10 — Gestion des erreurs silencieuse

Interdire les `catch { /* ignore */ }` pour une action utilisateur.

Chaque mutation doit fournir :

- état loading ;
- erreur visible ;
- toast ou inline feedback ;
- retry si pertinent ;
- log développement sans secrets ;
- aucun « clic qui ne fait rien ».

---

## 4. Remédiation mobile et UX

### 4.1 Breakpoints obligatoires

Tester explicitement :

- 320×568 ;
- 360×800 ;
- 375×667 ;
- 390×844 ;
- 412×915 ;
- 768×1024 ;
- desktop 1280+.

Aucun écran principal ne doit nécessiter de scroll horizontal.

### 4.2 Règles

- remplacer les `grid-cols-2` fixes par `grid-cols-1 sm:grid-cols-2` lorsque nécessaire ;
- autoriser wrap/stack du header admin ;
- remplacer les gros tableaux desktop par cartes ou listes responsives sur mobile ;
- ne pas masquer les débordements pour cacher les bugs ;
- utiliser `min-w-0`, `overflow-wrap:anywhere` et truncation uniquement quand sémantiquement acceptable ;
- hauteur interactive minimale 44 px ;
- compteur terrain : zones de tap 120–180 px ;
- gérer `env(safe-area-inset-*)` réellement ;
- retirer `user-scalable=no` et `maximum-scale=1` ;
- focus visible et navigation clavier pour l’admin.

---

## 5. Design system v1.2

### 5.1 Choix recommandé

Adopter **shadcn/ui** comme distribution de composants, avec primitives Radix lorsque pertinentes, et conserver Tailwind.

Objectif : réutiliser des comportements robustes sans adopter l’esthétique par défaut.

Composants à introduire :

- Button
- IconButton
- Input
- NumberInput
- Select
- Checkbox / Switch
- Card
- Badge
- Alert
- Dialog
- AlertDialog
- Sheet
- DropdownMenu
- Tabs
- Tooltip
- Toast
- Skeleton
- EmptyState
- ResponsiveDataList

Composants métier :

- EventStatusBadge
- EventLifecycleActions
- OccupancyGauge
- SyncHealth
- SpaceOccupancyCard
- CheckpointEditor
- TopologyPreview
- DeviceStatus
- PairingInviteCard
- CountActionButton
- OfflineBanner

### 5.2 Direction artistique

Éviter le « dashboard IA » uniforme :

- réduire l’usage systématique de `rounded-3xl` et `shadow-2xl` ;
- hiérarchie plus éditoriale ;
- surfaces plus plates ;
- bordures fines et états contrastés ;
- couleur de marque limitée ;
- couleur sémantique réservée aux états opérationnels ;
- typographie plus structurée ;
- espace et densité adaptés au contexte ;
- compteur terrain volontairement distinct de l’admin.

Créer des tokens CSS :

- `--background`
- `--surface`
- `--surface-raised`
- `--border`
- `--text`
- `--text-muted`
- `--accent`
- `--success`
- `--warning`
- `--danger`
- `--critical`
- `--radius-sm/md/lg`
- `--shadow-sm/md`

Ne pas répandre les valeurs Tailwind brutes dans tous les composants métier.

---

## 6. Architecture frontend cible

Proposition :

```text
apps/web/src/
  app/
    App.tsx
    providers/
      AuthProvider.tsx
      QueryProvider.tsx
  components/
    ui/
    domain/
  admin/
    layout/
    events/
      EventListPage.tsx
      EventSetupPage.tsx
      EventWizard.tsx
      EventLifecycleActions.tsx
      topology/
        SpacesEditor.tsx
        CheckpointsEditor.tsx
        TopologyPreview.tsx
    devices/
    analytics/
  counter/
    PairingPage.tsx
    CounterView.tsx
    components/
  api/
  offline/
  sse/
  styles/
```

TanStack Query doit devenir le mécanisme principal pour les données serveur admin :

- query keys centralisées ;
- mutations centralisées ;
- invalidation après mutation ;
- SSE met à jour le cache Query plutôt qu’un second arbre de state parallèle quand possible.

---

## 7. API et serveur

### 7.1 Draft complet

Ajouter un contrat de création/modification de draft qui permette un workflow cohérent.

Deux options acceptables :

**Option A — recommandée :**
`POST /api/v1/events/drafts` avec event + spaces + checkpoints, transaction unique.

**Option B :**
événement créé seul, puis `PUT /api/v1/events/:id/topology` atomique qui remplace la topologie tant que `draft`.

Éviter une série de 10 requêtes dépendantes sans rollback.

### 7.2 Preflight

Ajouter :

`GET /api/v1/events/:id/preflight`

Réponse :

```json
{
  "ready": false,
  "errors": [],
  "warnings": [],
  "summary": {
    "spaces": 3,
    "checkpoints": 4,
    "capacity": 1500
  }
}
```

Le start doit exécuter les mêmes validations côté serveur ; le preflight n’est qu’une prévisualisation.

### 7.3 Batch counting

Réévaluer l’atomicité du batch.

Exigence :

- idempotents déjà appliqués : reconnus sans effet ;
- nouvelles actions : prévalidées ;
- pas de demi-batch silencieux sur erreur structurelle ;
- acknowledgments précis ;
- transaction / stratégie documentée.

### 7.4 Logging

Supprimer tout `console.error` contenant SQL + params.

Passer par Pino avec redaction centralisée.

Ne jamais logger :

- setup token ;
- mots de passe ;
- cookies ;
- bearer tokens ;
- token QR ;
- session token ;
- payload sensible non nécessaire.

### 7.5 SQLite

Le dépôt utilise actuellement `node:sqlite` alors que la spécification historique mentionnait `better-sqlite3`.

Décision requise avant modification :

- soit revenir à `better-sqlite3` ;
- soit conserver `node:sqlite` et créer un ADR explicitant bénéfices, compatibilité, performances, packaging et différences.

Ne pas faire ce changement dans le même PR que la refonte UX.

---

## 8. Tests à ajouter

### 8.1 Unitaires / intégration

- transitions de cycle de vie ;
- preflight ;
- multiples checkpoints sur la même paire d’espaces ;
- transferts internes et conservation globale ;
- reversal interne ;
- batch idempotent ;
- checkpoint/event mismatch ;
- heartbeat ;
- QR expiré/utilisé/révoqué ;
- CSRF après renouvellement ;
- cache/outbox migration.

### 8.2 Playwright obligatoire

Ajouter Playwright avec projets :

- Chromium desktop ;
- Chromium mobile ;
- WebKit mobile au minimum en CI si stable.

Scénario principal :

1. instance vierge ;
2. setup admin ;
3. création événement `Festival Test`, capacité 100 ;
4. trois portes Extérieur ⇄ Site ;
5. zone VIP reliée au Site ;
6. sauvegarde draft ;
7. preflight ;
8. start ;
9. trois invitations QR ;
10. trois contextes appareil ;
11. comptages simultanés ;
12. vérification jauge admin ;
13. transfert Site → VIP et vérification global inchangé ;
14. offline d’un compteur ;
15. 5 taps offline ;
16. bannière incertitude admin ;
17. reconnexion ;
18. drain exact ;
19. undo ;
20. begin-closing ;
21. vérifier nouveaux taps bloqués ;
22. vérifier outbox existante drainée ;
23. close ;
24. export ;
25. refresh direct `/admin/...` et mutation réussie après bootstrap CSRF.

### 8.3 Tests visuels

Captures Playwright sur les viewports de section 4.

Échec si :

- overflow horizontal ;
- contenu interactif hors viewport ;
- texte coupé anormalement ;
- bouton inaccessible ;
- élément fixe masque l’action principale.

---

## 9. CI cible

Le nom des jobs doit refléter ce qui est réellement exécuté.

Pipeline minimum :

1. install ;
2. typecheck ;
3. lint ;
4. unit/integration tests ;
5. build ;
6. Playwright Chromium ;
7. éventuellement WebKit ;
8. Docker build ;
9. smoke test container ;
10. upload des screenshots/traces Playwright en cas d’échec.

Ajouter ESLint ou Biome, mais ne pas introduire un reformat massif dans le même commit que les corrections fonctionnelles.

---

## 10. Stratégie Git

Créer une branche :

`remediation/v1.2`

Puis PRs petits et révisables :

- PR 1 — tests de régression et AuthProvider/CSRF ;
- PR 2 — lifecycle admin + preflight ;
- PR 3 — wizard/topology multi-checkpoints ;
- PR 4 — pairing/heartbeat/QR ;
- PR 5 — offline projection + cache ;
- PR 6 — responsive/mobile ;
- PR 7 — design system + refactor UI ;
- PR 8 — CI/Playwright/Docker acceptance ;
- PR 9 — documentation et retrait du faux « production-ready ».

Chaque PR doit contenir ses propres tests.

Ne pas faire un commit monolithique « fix everything ».

---

## 11. Règles pour l’agent de développement

L’agent doit suivre une discipline de preuve.

Avant de modifier :

1. lire les fichiers concernés ;
2. lire les types / schémas partagés ;
3. lire les tests associés ;
4. reproduire le bug ;
5. formuler la cause ;
6. proposer un patch minimal ;
7. exécuter tests ciblés ;
8. exécuter typecheck ;
9. exécuter tests globaux pertinents ;
10. inspecter le diff.

Interdictions :

- ne pas inventer une API sans vérifier ;
- ne pas ajouter `any` pour « faire passer TypeScript » ;
- ne pas ignorer les erreurs ;
- ne pas supprimer un test qui échoue sans justification ;
- ne pas désactiver un invariant ;
- ne pas renommer/réarchitecturer hors scope ;
- ne pas déclarer « fixed » sans reproduction + test ;
- ne pas déclarer « production-ready » sur la seule base d’un build vert ;
- ne pas modifier `main` directement ;
- ne pas créer de nouveau framework maison si une primitive éprouvée existe.

---

## 12. Définition de done par ticket

Un ticket est terminé seulement si :

- cause identifiée ;
- comportement cible documenté ;
- code implémenté ;
- tests ajoutés ;
- typecheck vert ;
- tests ciblés verts ;
- aucun nouveau `any` injustifié ;
- aucun `catch` silencieux ajouté ;
- UI testée à 390 px si concernée ;
- screenshot ou trace si UI ;
- diff relu ;
- effets secondaires listés ;
- documentation mise à jour si contrat ou architecture change.

---

## 13. Gate « v1 exploitable »

PaxFlux ne peut être présenté comme v1 production/exploitation avant validation de tous les points :

- [ ] création d’un événement multi-portes réussie ;
- [ ] draft modifiable ;
- [ ] start explicite ;
- [ ] lifecycle complet admin ;
- [ ] QR depuis une machine différente ;
- [ ] 3 appareils simultanés ;
- [ ] heartbeat fiable ;
- [ ] comptage online exact ;
- [ ] comptage offline exact ;
- [ ] reconnexion exacte et idempotente ;
- [ ] transfert interne conserve le global ;
- [ ] undo exact ;
- [ ] closing bloque les nouveaux taps mais draine l’existant ;
- [ ] refresh admin ne casse pas le CSRF ;
- [ ] aucun overflow aux viewports cibles ;
- [ ] aucun clic muet ;
- [ ] Playwright scénario principal vert ;
- [ ] Docker fresh install vert ;
- [ ] export valide ;
- [ ] backup/restore smoke test vert ;
- [ ] documentation cohérente ;
- [ ] `ACCEPTANCE_REPORT` régénéré à partir des preuves réelles.

---

## 14. Priorité immédiate — premier lot de travail

Commencer uniquement par :

### Lot A
- installer/configurer Playwright ;
- écrire un test de reproduction du draft bloqué ;
- écrire un test de reload admin + mutation CSRF ;
- écrire un test compteur en draft/live/closing.

### Lot B
- AuthProvider global ;
- lifecycle admin ;
- preflight ;
- suppression auto-start wizard.

### Lot C
- éditeur multi-checkpoints ;
- API de draft/topologie atomique ;
- scénario E2E 3 portes.

Ne commencer le redesign qu’une fois Lots A–C fonctionnels.

---

## 15. Résultat attendu

À la fin de v1.2, PaxFlux doit donner une impression inverse de la version actuelle :

- aucune supposition cachée ;
- chaque état opérationnel est explicite ;
- les erreurs sont visibles ;
- la topologie représentée dans l’UI correspond réellement au modèle ;
- le mobile est la cible première ;
- les composants sont cohérents et maintenables ;
- les preuves E2E accompagnent les déclarations de fiabilité.
