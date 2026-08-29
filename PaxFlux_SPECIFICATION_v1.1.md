# PaxFlux — Spécification produit, UX et technique

**Version :** 1.1 — identité produit PaxFlux verrouillée, dossier de conception prêt pour implémentation  
**Date :** 29 août 2026  
**Statut :** baseline de développement  
**Nom produit :** **PaxFlux** — nom produit retenu. Le nom, le dépôt et les identifiants techniques doivent rester génériques et ne jamais être couplés au CROUS ni au festival Campulsations.  
**Licence recommandée :** Apache-2.0, à confirmer avant publication publique.

---

## 0. Résumé exécutable

PaxFlux est une application web progressive (PWA) self-hosted permettant à plusieurs agents de compter simultanément les entrées, sorties et transferts entre zones d'un événement, avec consolidation en temps réel, fonctionnement dégradé hors ligne, historique auditable, supervision et export.

Le besoin initial du CROUS Bordeaux est volontairement simple : plusieurs téléphones, des boutons d'entrée/sortie rapides, plusieurs zones éventuelles, une jauge commune en direct, un historique et une supervision. Le système doit rester utilisable par une équipe non technique et être déployable sur une seule machine, sans base de données ni SaaS externe.

La décision d'architecture est donc la suivante :

- PWA React/Vite/TypeScript, mobile-first ;
- backend Node.js 24 LTS + Fastify 5 ;
- SQLite local en mode WAL via `better-sqlite3` et Drizzle ORM ;
- écritures métier par API HTTP transactionnelle ;
- diffusion temps réel serveur → clients par Server-Sent Events (SSE), pas par WebSocket ;
- file locale d'actions dans IndexedDB pour le mode hors ligne ;
- idempotence systématique de chaque action de comptage ;
- authentification humaine par sessions HttpOnly ;
- compteurs terrain associés par QR à une session d'appareil, sans compte nominatif ;
- un seul conteneur applicatif, un seul processus, un seul port, un volume de données local ;
- Cloudflare Tunnel possible comme couche d'exposition, mais aucune dépendance fonctionnelle à Cloudflare ;
- aucune télémétrie, police, script, base ou service tiers obligatoire.

L'application doit être conçue comme un **outil de gestion de jauge et de flux**, pas comme un simple compteur partagé. Le journal des mouvements est la source de vérité ; la jauge courante est un état dérivé et matérialisé pour la rapidité.

---

## 1. Contexte et source du besoin

Le cahier des charges transmis par le CROUS Bordeaux le 2 juillet 2026 demande un décompte de jauge en direct avec :

- entrées et sorties ;
- plusieurs zones possibles ;
- plusieurs personnes saisissant simultanément depuis leur téléphone ;
- une jauge actuelle et une capacité maximale ;
- un historique des mouvements ;
- un affichage simple pour les responsables ;
- un volume attendu compatible avec environ 5 à 20 opérateurs concurrents.

La proposition initiale évoquait Airtable. La présente spécification remplace cette approche par une application spécialisée, self-hosted et open source.

### 1.1 Contraintes données par le porteur du projet

- développement maison souhaité, notamment comme projet de portfolio ;
- équipe utilisatrice réduite et non technique ;
- aucune dépendance attendue envers la DSI pour le premier événement ;
- hébergement temporaire possible sur un serveur personnel derrière Cloudflare ;
- dépôt GitHub public à terme ;
- possibilité de redéploiement autonome par le CROUS ou d'autres organisateurs ;
- déploiement idéalement « une commande Docker » ;
- base de données et données sur la même machine que l'application ;
- aucun BaaS ou service de données externe.

### 1.2 Positionnement produit

Le produit doit pouvoir être présenté génériquement comme :

> **A self-hosted, offline-capable, real-time occupancy and people-flow counter for events and venues.**

Le premier déploiement est Campulsations, mais le modèle doit rester réutilisable pour :

- concerts ;
- festivals ;
- expositions ;
- salles temporaires ;
- événements étudiants ;
- conférences ;
- sites avec sous-zones et plusieurs portes.

### 1.3 Identité produit et conventions de nommage

Le nom canonique du produit est **PaxFlux**. Il associe *pax* (personnes/passagers dans le vocabulaire événementiel) et *flux* (mouvements entre entrées, sorties et zones). Cette identité est volontairement indépendante du premier déploiement Campulsations.

Conventions à appliquer dans le code, le dépôt et les artefacts :

- nom d'affichage : `PaxFlux` ;
- slug technique canonique : `paxflux` ;
- nom de dépôt recommandé : `paxflux` ;
- package racine npm : `paxflux` ;
- packages workspace recommandés : `@paxflux/web`, `@paxflux/server`, `@paxflux/shared` ;
- image OCI/Docker : `ghcr.io/<owner>/paxflux:<version>` ;
- nom de conteneur par défaut : `paxflux` ;
- volumes d'exemple : `paxflux-data` et `paxflux-backups` ;
- titre produit court recommandé : **PaxFlux** ;
- description courte recommandée : **Self-hosted realtime crowd flow & occupancy management.**

Aucun identifiant applicatif, package, variable métier, nom de table, route, service Docker ou composant UI ne doit utiliser `Campulse`, `Campulsations` ou `CROUS` comme préfixe générique. Ces termes ne doivent apparaître que dans les exemples, fixtures, documentation du premier cas d'usage ou données de démonstration explicitement liées au festival.

Le domaine métier doit rester neutre : `event`, `space`, `checkpoint`, `movement`, `device_session`, etc. Le branding ne doit jamais contaminer les invariants ou le schéma fonctionnel.

---

## 2. Objectifs, non-objectifs et principes de décision

### 2.1 Objectifs P0

1. Permettre un comptage +1/-1 extrêmement rapide sur smartphone.
2. Permettre plusieurs appareils simultanés sans pertes ni doubles écritures causés par le réseau.
3. Afficher une jauge globale autoritative en quasi temps réel.
4. Permettre plusieurs portes et plusieurs zones internes.
5. Conserver un journal immuable des mouvements et corrections.
6. Continuer à saisir localement en cas de coupure réseau temporaire.
7. Rendre explicitement visible lorsque la jauge globale n'est plus garantie à cause d'une coupure.
8. Permettre un appairage par QR sans compte bénévole.
9. Fournir un tableau de supervision utilisable sans connaissances techniques.
10. Pouvoir exporter les données en CSV/JSON.
11. Pouvoir sauvegarder et restaurer la base localement.
12. Être installable dans un conteneur unique, sans service de base de données séparé.
13. Être raisonnablement sécurisé pour une exposition Internet publique.

### 2.2 Non-objectifs P0

Ne pas intégrer dans la première version :

- billetterie ;
- QR individuel pour les visiteurs ;
- reconnaissance vidéo ou caméra de comptage ;
- identification individuelle des visiteurs ;
- IA ou prédictions opérationnelles ;
- géolocalisation ;
- gestion RH des bénévoles ;
- microservices ;
- Kubernetes ;
- Redis ;
- PostgreSQL ;
- Supabase/Firebase/Airtable ;
- notifications push complexes ;
- application native iOS/Android ;
- synchronisation pair-à-pair entre téléphones ;
- multi-tenant SaaS ;
- conformité à une certification de sûreté particulière.

### 2.3 Principes d'architecture

- **Simplicité opérationnelle avant sophistication technique.**
- **Écritures HTTP, push SSE.** Aucune mutation métier sur le canal temps réel.
- **Journal avant compteur.** On enregistre des événements, on ne « modifie pas un nombre partagé ».
- **Idempotence avant retry.** Chaque action possède un identifiant unique.
- **Offline explicite.** Un téléphone déconnecté peut continuer à compter, mais personne ne prétend que la jauge globale reste exacte.
- **Pas de vérité cachée dans le client.** SQLite côté serveur est autoritaire ; IndexedDB ne contient que le cache et l'outbox locale.
- **Zéro SaaS obligatoire.** L'application doit fonctionner sur un LAN ou derrière n'importe quel reverse proxy.
- **Pas de données personnelles publiques inutiles.** Les visiteurs restent anonymes.
- **Topologie figée pendant le live.** Les zones et relations ne doivent pas être réécrites pendant le comptage.
- **Pas de suppression destructive du journal.** Les erreurs sont corrigées par opérations compensatoires.

---

## 3. Terminologie métier

### 3.1 Événement

Un `event` est une session opérationnelle de comptage cohérente : par exemple « Campulsations Bordeaux — 24 septembre 2026 ».

Pour une édition sur plusieurs jours, créer un événement par journée si les jauges repartent de zéro. Une fonction de duplication de configuration pourra être ajoutée ultérieurement.

### 3.2 Espace

Un `space` représente un endroit logique. Trois types existent :

- `leaf` : espace réel dans lequel une personne peut être comptée ;
- `aggregate` : groupe d'espaces utilisé uniquement pour agréger et afficher une capacité ;
- `external` : extérieur virtuel à l'événement, non compté dans la jauge.

**Règle critique : les espaces `leaf` doivent être mutuellement exclusifs.** Une personne doit être dans exactement un espace feuille interne à un instant donné.

Exemple correct :

- Zone générale ;
- Salle A ;
- VIP ;
- Terrasse.

Le « site total » est la somme de ces feuilles et non une feuille supplémentaire qui les contiendrait, sinon on compterait certaines personnes deux fois.

### 3.3 Checkpoint

Un `checkpoint` est une porte, un passage ou une frontière physique entre deux espaces.

Exemples :

- Porte A : Extérieur ⇄ Zone générale ;
- Porte B : Extérieur ⇄ Zone générale ;
- Entrée VIP : Zone générale ⇄ VIP ;
- Porte Salle A : Zone générale ⇄ Salle A.

Plusieurs checkpoints peuvent relier les mêmes espaces pour conserver les statistiques par porte.

### 3.4 Mouvement

Un `movement` est un événement immuable du journal. Il déplace une quantité entre deux espaces, ou applique une correction contrôlée.

Types :

- `count` : action normale d'un compteur ;
- `reversal` : annulation compensatoire d'une action existante ;
- `adjustment` : correction supervisée avec motif obligatoire.

### 3.5 Appareil compteur

Un téléphone n'est pas un utilisateur humain. Il possède une `device_session` liée à un événement et à un checkpoint. La session est obtenue par appairage QR.

### 3.6 Superviseur

Utilisateur humain authentifié pouvant suivre le live, créer des accès compteurs, révoquer des appareils, corriger les jauges et terminer l'événement.

### 3.7 Administrateur

Utilisateur humain authentifié disposant en plus de la configuration de l'instance, de la topologie, des comptes humains, des sauvegardes et des opérations sensibles.

---

## 4. Invariants métier non négociables

L'implémentation doit tester explicitement ces invariants.

1. Un checkpoint appartient à exactement un événement.
2. Les deux extrémités d'un checkpoint sont différentes.
3. Un espace `aggregate` ne peut jamais être extrémité d'un checkpoint.
4. Un compteur est lié à exactement un checkpoint pendant toute sa session.
5. Changer de checkpoint revient à révoquer la session et en créer une nouvelle.
6. Une action compteur normale déplace toujours exactement une personne (`quantity = 1`).
7. Une correction de superviseur peut déplacer une quantité supérieure à 1, mais exige un motif.
8. Une action `client_action_id` ne peut être appliquée qu'une fois.
9. Une seule annulation directe peut cibler un mouvement donné.
10. Les mouvements ne sont jamais supprimés lors d'une correction.
11. Les personnes entrant dans une zone interne depuis une autre zone interne ne modifient pas la jauge globale de l'événement.
12. Un mouvement entre l'extérieur et un espace interne modifie la jauge globale.
13. Atteindre ou dépasser une capacité ne bloque jamais l'enregistrement de la réalité.
14. Une jauge négative n'est pas silencieusement corrigée : elle est enregistrée et signalée comme anomalie.
15. Le client ne décide jamais de la jauge autoritative ; il envoie des actions.
16. Les heures serveur sont autoritatives pour l'ordre et l'audit. L'heure client est seulement diagnostique.
17. Le statut `closed` interdit toute nouvelle action de comptage.
18. La topologie est modifiable en `draft`, puis verrouillée à l'entrée en `live`.
19. Les modifications de capacité pendant le live sont autorisées mais auditées.
20. Les événements archivés sont en lecture seule.

---

## 5. Cycle de vie d'un événement

### 5.1 États

`draft → live → closing → closed → archived`

#### `draft`

- configuration des espaces/checkpoints ;
- génération et appairage possible des appareils ;
- compteurs désactivés ;
- topologie modifiable.

#### `live`

- comptage actif ;
- topologie verrouillée ;
- ajout/révocation d'appareils autorisé ;
- capacité modifiable avec audit ;
- ajustements supervisés autorisés.

#### `closing`

État opérationnel de drainage de synchronisation.

- les clients connectés reçoivent immédiatement l'ordre de désactiver les nouveaux taps ;
- les appareils qui reviennent en ligne peuvent vider leur outbox ;
- le superviseur visualise les appareils hors ligne et la dernière synchronisation connue ;
- l'événement n'est finalisé qu'après vérification ou action explicite « forcer la fermeture ».

Cet état évite de fermer brutalement un événement alors que des appareils possèdent encore des actions hors ligne.

#### `closed`

- aucune nouvelle action compteur ;
- lecture, export et analyse autorisés ;
- réouverture uniquement par administrateur avec avertissement et trace d'audit.

#### `archived`

- lecture seule ;
- masqué par défaut dans la liste active ;
- les sessions appareils sont révoquées.

### 5.2 Transition vers `live`

Avant activation, le serveur vérifie :

- capacité globale valide ;
- au moins un espace feuille interne ;
- au moins un checkpoint actif ;
- aucune boucle de parentage des espaces ;
- aucun checkpoint vers un agrégat ;
- base de données saine ;
- dernière sauvegarde acceptable ou sauvegarde créée immédiatement ;
- topologie cohérente.

Le passage `draft → live` est une transaction auditable.

### 5.3 Transition `live → closing`

La boîte de dialogue doit afficher :

- nombre d'appareils actifs ;
- nombre connectés ;
- appareils hors ligne ;
- dernière valeur connue de `pending_count` par appareil ;
- avertissement si la jauge est potentiellement incomplète.

### 5.4 `closing → closed`

Deux voies :

- fermeture normale après synchronisation ;
- fermeture forcée, nécessitant une confirmation forte et un motif d'audit.

---

## 6. Personas et droits

| Persona | Authentification | Peut compter | Voir live | Corriger | Configurer topologie | Gérer comptes | Sauvegardes |
|---|---|---:|---:|---:|---:|---:|---:|
| Compteur | session appareil QR | Oui | limité | annuler sa dernière action | Non | Non | Non |
| Superviseur | username + mot de passe | Non | Oui | Oui | Non en live | Non | lecture état |
| Administrateur | username + mot de passe | Non | Oui | Oui | Oui en draft | Oui | Oui |

### 6.1 Règles de rôle

- Le compteur n'accède qu'à son événement, son checkpoint, son état utile et ses propres actions récentes.
- Le superviseur peut démarrer/mettre en fermeture/finaliser un événement, créer et révoquer des invitations/appareils, corriger et exporter.
- L'administrateur peut en plus créer/modifier la topologie, gérer les utilisateurs, restaurer une sauvegarde, réouvrir un événement et purger des archives.

---

## 7. Parcours utilisateur — première installation

### 7.1 Démarrage du conteneur

L'application détecte qu'aucun utilisateur administrateur n'existe.

Pour empêcher un tiers de prendre le contrôle d'une instance neuve exposée sur Internet, le serveur génère un **setup token à forte entropie**.

Le token :

- est imprimé une seule fois dans les logs de démarrage ;
- peut également être écrit dans `/data/setup-token.txt` avec permissions `0600` ;
- est stocké côté serveur uniquement sous forme de hash ;
- expire après 24 h ;
- devient invalide après création du premier administrateur.

### 7.2 Écran `/setup`

Champs :

1. setup token ;
2. nom d'utilisateur administrateur ;
3. mot de passe ;
4. confirmation mot de passe ;
5. nom facultatif de l'instance.

Après succès :

- premier compte `admin` créé ;
- setup token invalidé ;
- session admin créée ;
- redirection vers le wizard de premier événement.

### 7.3 Réinitialisation du mot de passe

Aucun serveur mail n'est requis.

Prévoir une commande d'administration locale dans le conteneur :

```bash
node dist/cli.js admin reset-password <username>
```

La commande génère un token de réinitialisation à usage unique ou permet une saisie interactive selon le contexte TTY.

---

## 8. Parcours utilisateur — création d'un événement

### 8.1 Wizard étape 1 : informations générales

- nom ;
- date/heure indicatives ;
- fuseau IANA, défaut `Europe/Paris` ;
- capacité globale ;
- seuils d'alerte, défaut 80 %, 90 %, 100 % ;
- description facultative.

### 8.2 Wizard étape 2 : modèle de zones

Deux choix simples :

#### Mode « jauge globale uniquement »

Le système crée :

- `Extérieur` (`external`) ;
- `Site` (`leaf`).

L'utilisateur n'a ensuite qu'à créer les portes physiques.

#### Mode « plusieurs zones »

Le wizard explique :

> Une personne doit être comptée dans une seule zone à la fois. Créez une zone « générale » si vous souhaitez représenter les personnes qui ne sont ni en VIP, ni en salle, ni sur une terrasse spécifique.

L'utilisateur crée les feuilles et éventuellement des agrégats d'affichage.

### 8.3 Wizard étape 3 : checkpoints

Pour chaque checkpoint :

- nom physique ;
- espace A ;
- espace B ;
- direction A→B active ? ;
- direction B→A active ? ;
- libellé terrain de chaque bouton.

Exemples de libellés :

- `ENTRÉE +1` ;
- `SORTIE −1` ;
- `→ VIP` ;
- `← RETOUR SITE`.

### 8.4 Wizard étape 4 : validation de topologie

Afficher une représentation lisible :

```text
Extérieur
   ⇅ Porte A
Zone générale
   ⇅ Entrée VIP
VIP
```

Détecter avant sauvegarde :

- checkpoint sans direction ;
- agrégat utilisé comme endpoint ;
- espace feuille inaccessible si cela semble non intentionnel ;
- capacité d'une zone supérieure à la capacité globale (avertissement, pas blocage) ;
- noms dupliqués ambigus.

---

## 9. Parcours utilisateur — appairage d'un compteur

### 9.1 Création d'une invitation

Le superviseur ouvre `Appareils` → `Ajouter un compteur` → choisit le checkpoint.

Le serveur génère :

- un token aléatoire d'au moins 256 bits ;
- une invitation à usage unique ;
- expiration par défaut 30 minutes, configurable lors de la création ;
- token stocké hashé uniquement.

Le QR encode une URL de la forme :

```text
https://count.example.org/pair#<token>
```

Le secret est placé dans le **fragment URL**, qui n'est pas envoyé automatiquement au serveur, aux logs HTTP ou au header Referer.

### 9.2 Échange du token

Le navigateur ouvre `/pair`, le JavaScript lit le fragment puis le retire immédiatement de l'URL via `history.replaceState`.

Il envoie ensuite le token dans un POST JSON vers `/api/device/pair`.

Le serveur :

1. hash le token reçu ;
2. retrouve l'invitation ;
3. vérifie expiration, révocation et usage ;
4. crée une `device_session` ;
5. marque l'invitation utilisée ;
6. émet un cookie de session appareil HttpOnly ;
7. renvoie la configuration du checkpoint.

### 9.3 Expérience utilisateur

Aucun formulaire nominatif n'est requis.

L'appareil reçoit automatiquement un libellé du type :

`Porte A — appareil 3`

Le superviseur pourra le renommer facultativement.

### 9.4 Préparation avant l'événement

Une fois appairé en `draft`, le téléphone doit pouvoir :

- télécharger l'app shell PWA ;
- mémoriser la configuration ;
- vérifier IndexedDB ;
- afficher un écran « Prêt pour le mode hors ligne » ;
- rester désactivé jusqu'au passage en `live`.

---

## 10. UX du compteur terrain

### 10.1 Principe

Le compteur ne doit pratiquement jamais naviguer.

Après appairage, son écran principal est son outil de travail entier.

### 10.2 Composition de l'écran

Ordre recommandé :

1. nom de l'événement, discret ;
2. nom du checkpoint, très visible ;
3. état de connexion/synchronisation ;
4. jauge pertinente ;
5. deux très grands boutons directionnels ;
6. dernière action et bouton annuler ;
7. compteur d'actions locales non synchronisées si >0.

Exemple :

```text
CAMPULSATIONS
PORTE A                              ● EN LIGNE

              1 247 / 1 500
              253 places restantes

┌──────────────────────────────────────────┐
│                                          │
│                ENTRÉE +1                 │
│                                          │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│                                          │
│                SORTIE −1                 │
│                                          │
└──────────────────────────────────────────┘

Dernière action : Entrée ✓                 ANNULER
```

### 10.3 Taille et ergonomie

- cible tactile minimale générale : 48×48 CSS px ;
- boutons de comptage : idéalement 120 à 180 px de hauteur sur mobile ;
- aucun petit bouton adjacent aux boutons principaux ;
- actions séparées visuellement et spatialement ;
- support portrait prioritaire ;
- utilisable d'une main ;
- aucun geste complexe ;
- aucun `double-click debounce` qui supprimerait des taps légitimes rapides.

### 10.4 Feedback d'un tap

À chaque tap :

1. création transactionnelle de l'action dans IndexedDB ;
2. mise à jour optimiste de l'affichage ;
3. feedback visuel immédiat ;
4. vibration légère si `navigator.vibrate` est disponible et activée ;
5. tentative d'envoi réseau ;
6. passage à l'état confirmé après ACK.

Ne jamais attendre le serveur pour donner le feedback tactile initial.

### 10.5 États de connexion

#### En ligne

`● EN LIGNE — synchronisé`

#### Envoi en cours

`● SYNCHRONISATION — 3 actions en attente`

#### Hors ligne

`⚠ HORS LIGNE — le comptage continue sur cet appareil`

Sous-message obligatoire :

> La jauge globale peut être incomplète tant que cet appareil n'est pas resynchronisé.

#### Session révoquée/expirée

Le comptage est bloqué. Les actions locales existantes ne sont jamais supprimées automatiquement.

### 10.6 État de capacité

Le compteur peut voir la jauge, mais la capacité ne doit jamais désactiver le bouton.

Exemple :

`1 512 / 1 500 — dépassement +12`

Le serveur enregistre encore les actions.

### 10.7 Sous-zone

Pour un checkpoint interne :

```text
ENTRÉE VIP

VIP : 51 / 80
Total événement : 1 247 / 1 500

[ → VIP ]
[ ← ZONE GÉNÉRALE ]
```

### 10.8 Wake Lock

Utiliser Screen Wake Lock comme amélioration progressive lorsqu'il est supporté, après interaction utilisateur. Ne jamais rendre le fonctionnement dépendant de cette API.

### 10.9 Accessibilité

- ne jamais coder l'état uniquement par couleur ;
- texte + icône + couleur ;
- `aria-label` explicites ;
- respect de `prefers-reduced-motion` ;
- contraste WCAG AA ;
- police système ou police embarquée localement uniquement ;
- focus visible pour usage clavier ;
- gros caractères pour les valeurs critiques.

---

## 11. Annulation d'une action compteur

L'annulation est un cas distribué délicat et doit être conçue explicitement.

### 11.1 Action jamais envoyée

Si la dernière action a `attempts = 0`, elle peut être supprimée localement de l'outbox et l'optimistic delta est annulé.

### 11.2 Action envoyée et confirmée

Créer une nouvelle action locale de type `reversal` qui cible l'action d'origine. Le serveur crée un mouvement compensatoire inverse.

### 11.3 Action envoyée mais ACK inconnu

**Ne jamais supprimer l'action originale.** Le serveur a peut-être déjà appliqué l'écriture alors que la réponse s'est perdue.

Le client conserve l'original et ajoute un `reversal` ciblant le `client_action_id` original.

Au prochain sync :

- si l'original a déjà été appliqué, le serveur applique l'inverse ;
- si original et reversal arrivent dans le même batch, ils s'appliquent dans cet ordre ;
- le résultat net est nul ;
- aucune ambiguïté n'est créée.

### 11.4 Limites

Le compteur peut uniquement annuler sa propre dernière action récente. Une correction plus ancienne ou arbitraire passe par un superviseur.

---

## 12. Tableau de supervision

### 12.1 Objectif

Donner en une vue l'état opérationnel et la qualité du comptage.

### 12.2 Bloc global

Afficher :

- jauge actuelle ;
- capacité ;
- places restantes ou dépassement ;
- pourcentage ;
- statut événement ;
- qualité de synchronisation.

### 12.3 Qualité de synchronisation

État dérivé indépendant de la jauge :

- **Fiable** : tous les appareils attendus récemment actifs sont connectés et aucun problème connu ;
- **Dégradée** : un appareil attendu est hors ligne, une file locale avait été signalée, ou un autre signal réduit la confiance ;
- **Non garantie** : plusieurs appareils hors ligne ou incident serveur/réseau majeur.

Le dashboard ne doit jamais inventer une marge numérique d'incertitude qu'il ne peut pas connaître.

### 12.4 Zones

Pour chaque feuille et agrégat :

- nom ;
- jauge ;
- capacité éventuelle ;
- pourcentage ;
- alerte ;
- tendance courte facultative.

### 12.5 Flux récents

Sur 5 minutes :

- entrées depuis l'extérieur ;
- sorties vers l'extérieur ;
- solde ;
- flux par checkpoint.

Ne pas appeler les entrées cumulées « visiteurs uniques ». Sans identité visiteur, une réentrée est une nouvelle entrée.

### 12.6 Appareils

Liste :

- checkpoint ;
- label ;
- connecté/hors ligne ;
- dernier contact ;
- dernier nombre d'actions pending annoncé ;
- version de l'application ;
- révocation.

### 12.7 Alertes opérationnelles

- capacité 80/90/100 % ;
- dépassement ;
- jauge négative ;
- appareil hors ligne depuis >45 s ;
- dernière sauvegarde trop ancienne ;
- espace incohérent ;
- événement en `closing` avec appareil offline.

---

## 13. Corrections et ajustements supervisés

### 13.1 Principe

Un superviseur ne modifie jamais directement `space_state.occupancy`.

Il crée une opération d'ajustement auditable.

### 13.2 UX recommandée

```text
Corriger la jauge — VIP
Valeur système : 51
Valeur observée : [ 56 ]
Correction calculée : +5
Motif : [ recomptage manuel après coupure ]
```

Le serveur crée un `movement(kind=adjustment, quantity=5)`.

### 13.3 Motif

Obligatoire, 3 à 500 caractères.

### 13.4 Annulation d'une correction

Une correction peut elle-même être annulée par une opération `reversal`, jamais par suppression.

---

## 14. Analytics et exports

### 14.1 P0

- jauge courante ;
- pic de jauge et heure du pic ;
- entrées cumulées depuis l'extérieur ;
- sorties cumulées vers l'extérieur ;
- flux par checkpoint ;
- historique chronologique ;
- courbe de jauge par pas temporel ;
- CSV des mouvements ;
- JSON de l'événement et de sa topologie.

### 14.2 Données non calculables sans tracking individuel

Ne pas prétendre fournir :

- visiteurs uniques ;
- temps de séjour individuel ;
- parcours individuel ;
- taux de réentrée par personne.

### 14.3 Protection CSV

Toute valeur textuelle issue d'un utilisateur et commençant par `=`, `+`, `-` ou `@` doit être neutralisée pour éviter la CSV/formula injection dans les tableurs.

Encodage UTF-8, en-têtes stables et timestamps ISO 8601 dans les exports.

---

## 15. Architecture cible

```text
                    UTILISATEURS
          ┌──────────────┴──────────────┐
          │                             │
     PWA compteurs                 Dashboard admin
          │                             │
          ├──────── HTTPS POST/GET ─────┤
          │                             │
          └────────── SSE GET ──────────┘
                        │
                        ▼
              ┌──────────────────┐
              │  Fastify / Node  │
              │                  │
              │  API HTTP        │
              │  Auth / RBAC     │
              │  Domain service  │
              │  SSE broadcaster │
              │  Static PWA      │
              └────────┬─────────┘
                       │
                  better-sqlite3
                       │
              ┌────────▼─────────┐
              │ SQLite WAL       │
              │ /data/app.db     │
              └──────────────────┘
```

### 15.1 Pourquoi SSE plutôt que WebSocket

Les clients n'ont besoin d'aucune écriture bidirectionnelle persistante. Les écritures sont mieux gérées par HTTP pour :

- idempotence ;
- statut HTTP ;
- retries ;
- CSRF ;
- observabilité ;
- tests.

SSE apporte :

- serveur → client natif ;
- reconnexion automatique via `EventSource` ;
- HTTP standard à travers reverse proxies ;
- message IDs ;
- moins de surface de sécurité qu'un canal WebSocket métier.

Si une contrainte réelle découverte pendant le développement rend SSE insuffisant, documenter un ADR avant tout passage à WebSocket.

### 15.2 Stack cible

#### Runtime

- Node.js 24 LTS ;
- npm + `package-lock.json` ;
- TypeScript strict.

#### Backend

- Fastify 5 ;
- `@fastify/static` ;
- `@fastify/cookie` ;
- `@fastify/helmet` ;
- `@fastify/rate-limit` ;
- `@fastify/sse` ;
- schema validation via JSON Schema / type provider Fastify officiellement compatible ;
- Drizzle ORM ;
- `better-sqlite3` ;
- Argon2id pour les mots de passe.

#### Frontend

- React ;
- Vite ;
- TypeScript ;
- React Router ;
- TanStack Query pour l'état serveur ;
- Dexie ou abstraction IndexedDB équivalente pour l'outbox ;
- `vite-plugin-pwa` avec service worker contrôlé ;
- bibliothèque de graphiques légère uniquement si nécessaire.

#### Tests

- Vitest ;
- tests Fastify inject ;
- Playwright ;
- outil de charge léger comme autocannon.

### 15.3 Interdictions techniques P0

- Next.js sans justification ;
- SSR ;
- GraphQL ;
- Socket.IO ;
- Redis ;
- service worker qui intercepte et met en cache les POST métier ;
- stockage de credential dans `localStorage` ;
- dépendance obligatoire à Background Sync ;
- CDN JavaScript ou police externe.

---

## 16. SQLite — configuration et garanties

### 16.1 Pourquoi SQLite

Le volume est minuscule au regard de SQLite. Le serveur est unique, les transactions sont courtes et la base doit rester locale. SQLite évite un second service à déployer et sauvegarder.

### 16.2 PRAGMA au démarrage

Vérifier et appliquer :

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Le mode WAL autorise les lectures pendant une écriture, mais ne permet qu'un writer à la fois. Ici, c'est volontaire et suffisant.

### 16.3 Stockage

- base sur stockage local de la machine ;
- jamais NFS/SMB pour le fichier actif en WAL ;
- `/data/app.db` ;
- `/backups/` séparé logiquement et montable sur un autre disque local ;
- permissions restreintes.

### 16.4 Connexion unique

Préférer une connexion SQLite unique dans le processus serveur pour les mutations. Les transactions synchrones `better-sqlite3` sont acceptables car les requêtes sont très courtes.

### 16.5 Checkpoint WAL

Conserver l'auto-checkpoint SQLite par défaut au départ. Surveiller la taille du WAL dans le panneau système. Si la taille devient anormale, déclencher un checkpoint contrôlé en période calme.

Ne pas micro-optimiser avant mesure.

---

## 17. Modèle de données logique

### 17.1 `instance_settings`

| Champ | Type logique | Notes |
|---|---|---|
| id | integer | singleton = 1 |
| instance_name | text | nom affiché |
| initialized_at_ms | integer | UTC epoch ms |
| created_at_ms | integer | |
| updated_at_ms | integer | |

### 17.2 `staff_users`

| Champ | Type | Notes |
|---|---|---|
| id | UUID text | PK |
| username | text | affichage |
| username_normalized | text | UNIQUE |
| display_name | text nullable | |
| role | enum | admin/supervisor |
| password_hash | text | Argon2id |
| is_active | boolean | |
| created_at_ms | integer | |
| updated_at_ms | integer | |
| last_login_at_ms | integer nullable | |

### 17.3 `staff_sessions`

| Champ | Type | Notes |
|---|---|---|
| id | UUID text | PK |
| user_id | UUID | FK |
| token_hash | text/blob | UNIQUE |
| csrf_hash | text/blob | |
| created_at_ms | integer | |
| last_seen_at_ms | integer | |
| expires_at_ms | integer | |
| revoked_at_ms | integer nullable | |

### 17.4 `events`

| Champ | Type | Notes |
|---|---|---|
| id | UUID text | PK |
| name | text | 1..120 |
| slug | text | unique lisible |
| timezone | text | IANA |
| capacity | integer | >= 0 |
| status | enum | draft/live/closing/closed/archived |
| warning_ratio_1 | real | défaut .80 |
| warning_ratio_2 | real | défaut .90 |
| starts_at_ms | integer nullable | indicatif |
| ends_at_ms | integer nullable | indicatif |
| live_started_at_ms | integer nullable | serveur |
| closing_started_at_ms | integer nullable | |
| closed_at_ms | integer nullable | |
| archived_at_ms | integer nullable | |
| version | integer | monotone par mutation transactionnelle |
| topology_locked_at_ms | integer nullable | |
| created_by | UUID | FK user |
| created_at_ms | integer | |
| updated_at_ms | integer | |

### 17.5 `spaces`

| Champ | Type | Notes |
|---|---|---|
| id | UUID text | PK |
| event_id | UUID | FK |
| parent_id | UUID nullable | uniquement agrégation |
| name | text | |
| kind | enum | leaf/aggregate/external |
| capacity | integer nullable | capacité locale ou agrégée |
| sort_order | integer | |
| is_active | boolean | |
| created_at_ms | integer | |
| updated_at_ms | integer | |

Contraintes applicatives :

- pas de cycle parent/enfant ;
- `external` sans parent/capacité ;
- `aggregate` jamais endpoint ;
- seules les feuilles internes ont un `space_state`.

### 17.6 `space_state`

| Champ | Type | Notes |
|---|---|---|
| event_id | UUID | PK composite |
| space_id | UUID | PK composite |
| occupancy | integer | peut être négatif si anomalie réelle de comptage |
| updated_at_ms | integer | |

### 17.7 `checkpoints`

| Champ | Type | Notes |
|---|---|---|
| id | UUID text | PK |
| event_id | UUID | FK |
| name | text | |
| space_a_id | UUID | FK |
| space_b_id | UUID | FK |
| allow_a_to_b | boolean | |
| allow_b_to_a | boolean | |
| label_a_to_b | text | bouton |
| label_b_to_a | text | bouton |
| sort_order | integer | |
| is_active | boolean | |
| created_at_ms | integer | |
| updated_at_ms | integer | |

### 17.8 `device_invites`

| Champ | Type | Notes |
|---|---|---|
| id | UUID | PK |
| event_id | UUID | FK |
| checkpoint_id | UUID | FK |
| token_hash | text/blob | UNIQUE |
| expires_at_ms | integer | |
| created_by | UUID | staff |
| created_at_ms | integer | |
| used_at_ms | integer nullable | |
| revoked_at_ms | integer nullable | |

### 17.9 `device_sessions`

| Champ | Type | Notes |
|---|---|---|
| id | UUID | PK |
| event_id | UUID | FK |
| checkpoint_id | UUID | immuable |
| label | text | auto-renommable |
| token_hash | text/blob | UNIQUE |
| created_at_ms | integer | |
| expires_at_ms | integer | prévoir marge après fin événement |
| revoked_at_ms | integer nullable | |
| last_seen_at_ms | integer nullable | |
| last_pending_count | integer | dernière valeur connue |
| last_client_sequence | integer nullable | diagnostic |
| app_version | text nullable | diagnostic |

### 17.10 `movements`

| Champ | Type | Notes |
|---|---|---|
| id | integer autoincrement | ordre serveur |
| event_id | UUID | FK |
| checkpoint_id | UUID nullable | null pour certains ajustements |
| device_session_id | UUID nullable | acteur compteur |
| actor_user_id | UUID nullable | acteur staff |
| kind | enum | count/reversal/adjustment |
| client_action_id | UUID text nullable | UNIQUE pour actions client |
| device_sequence | integer nullable | diagnostic |
| from_space_id | UUID nullable | null autorisé pour adjustment |
| to_space_id | UUID nullable | null autorisé pour adjustment |
| quantity | integer | >0 |
| reverses_movement_id | integer nullable | FK self, unique direct |
| reason | text nullable | obligatoire adjustment |
| client_time_ms | integer nullable | non autoritatif |
| server_time_ms | integer | autoritatif |
| event_version | integer | version après transaction |
| source | enum | online/offline_batch/staff |

### 17.11 `audit_log`

Configuration et sécurité, distinct du journal de mouvements.

Champs :

- id ;
- event_id nullable ;
- actor_user_id nullable ;
- action ;
- entity_type ;
- entity_id ;
- metadata JSON non sensible ;
- created_at_ms.

Ne jamais enregistrer token, cookie, mot de passe, URL QR complète ou secret.

### 17.12 `backup_records`

- id ;
- filename ;
- reason ;
- size_bytes ;
- sha256 ;
- quick_check_ok ;
- created_at_ms.

---

## 18. Index et contraintes essentiels

Au minimum :

- unique `staff_users(username_normalized)` ;
- unique `staff_sessions(token_hash)` ;
- unique `device_invites(token_hash)` ;
- unique `device_sessions(token_hash)` ;
- unique `movements(client_action_id)` lorsque non null ;
- index `movements(event_id, server_time_ms)` ;
- index `movements(event_id, checkpoint_id, server_time_ms)` ;
- index `movements(device_session_id, server_time_ms)` ;
- index `device_sessions(event_id, last_seen_at_ms)` ;
- index `spaces(event_id, parent_id)` ;
- index `checkpoints(event_id)`.

Ajouter des `CHECK` SQL simples lorsque SQLite/Drizzle le permet, tout en gardant les invariants de graphe dans le domaine applicatif.

---

## 19. Algorithme transactionnel d'une action de comptage

Pseudo-code autoritatif :

```text
receive action
  authenticate device session
  validate CSRF/origin as applicable
  validate payload size/schema
  load event + checkpoint
  ensure event status allows sync (live or closing)
  ensure session active and bound to checkpoint
  map direction -> from_space / to_space

BEGIN IMMEDIATE
  if client_action_id already exists:
      return idempotent success using existing movement

  insert movement(kind=count)
  if from is internal leaf: occupancy -= 1
  if to is internal leaf:   occupancy += 1
  event.version += 1
  stamp movement.event_version = new version
COMMIT

broadcast coalesced SSE state after commit
return ACK + authoritative compact state
```

### 19.1 Dépassement et valeur négative

Aucun `CHECK occupancy >= 0` ni `occupancy <= capacity`.

Le système doit refléter une incohérence de terrain plutôt que perdre une action.

---

## 20. Batch de synchronisation offline

### 20.1 Endpoint

`POST /api/device/actions/batch`

### 20.2 Taille

- 1 à 100 actions par requête ;
- payload limité ;
- le client boucle si l'outbox est plus grande.

### 20.3 Ordre

Actions triées par ordre local de création.

`device_sequence` sert au diagnostic des trous et doublons, mais **ne bloque pas** l'application car une action jamais envoyée peut être annulée localement et créer un trou légitime.

### 20.4 Sémantique transactionnelle

Le serveur pré-valide toutes les actions non déjà connues. Une erreur métier non idempotente bloque l'application des nouvelles actions du batch et retourne un conflit explicite.

Les doublons idempotents sont considérés comme succès.

### 20.5 Reversal dans un batch

Un reversal peut cibler un `client_action_id` :

- présent dans la base ;
- ou inséré plus tôt dans le même batch.

Ainsi, une action incertaine et son annulation peuvent être synchronisées ensemble sans ambiguïté.

---

## 21. Mode hors ligne — architecture client

### 21.1 Ce qui doit fonctionner hors ligne

Après un premier chargement et un appairage réussi :

- l'interface compteur se recharge ;
- les boutons continuent à produire des actions locales ;
- le delta local est affiché ;
- l'outbox persiste à un redémarrage du navigateur ;
- la synchronisation reprend automatiquement au retour réseau.

### 21.2 Ce qui ne peut pas être garanti hors ligne

Un appareil déconnecté ne peut pas connaître les actions des autres appareils.

La jauge globale affichée hors ligne est donc :

`dernier état serveur connu + actions locales pending de cet appareil`

Elle n'est pas la vérité globale.

### 21.3 IndexedDB

Stores recommandés :

#### `outbox_actions`

- client_action_id ;
- device_sequence ;
- type ;
- direction ou target_client_action_id ;
- client_created_at_ms ;
- attempts ;
- send_state ;
- last_error_code.

#### `device_cache`

- event config ;
- checkpoint config ;
- dernier compact state serveur ;
- build version.

#### `meta`

- next_sequence ;
- schema version IndexedDB.

### 21.4 Action atomique locale

Le tap et l'incrément de `next_sequence` doivent être enregistrés dans la même transaction IndexedDB.

### 21.5 Retry

Déclencheurs :

- juste après création ;
- événement `online` ;
- retour de focus ;
- timer court tant qu'une outbox existe et que l'app est au premier plan.

Backoff court avec plafond, par exemple : 0,5 s → 1 s → 2 s → 5 s.

Ne pas dépendre de l'API Background Sync, car son support navigateur n'est pas universel. Elle peut être utilisée uniquement comme amélioration progressive.

### 21.6 Erreurs non retryables

- 401/403 : session invalide → bloquer et informer ;
- 409 métier : afficher conflit ;
- event closed : arrêter les nouveaux taps ;
- 429 : respecter `Retry-After`.

Une action locale rejetée ne doit pas être supprimée sans confirmation utilisateur/superviseur.

---

## 22. Service worker et PWA

### 22.1 Cache

- assets hashés : cache-first/immutable ;
- `index.html` : réseau d'abord avec fallback cache ;
- manifest/icons : cache ;
- API GET dynamique : réseau ;
- API POST/PUT/PATCH/DELETE : **jamais mise en cache ni rejouée par magie par le service worker**.

### 22.2 Mise à jour

Ne pas activer une nouvelle version en plein événement sans contrôle.

Politique :

- nouveau service worker détecté ;
- bannière « Mise à jour disponible » ;
- activation au reload explicite ;
- règle d'exploitation : **aucun déploiement pendant un événement `live` ou `closing`**, sauf incident critique.

### 22.3 Compatibilité version

Le serveur expose :

- `serverVersion` ;
- `buildId` ;
- `apiVersion`.

Le client envoie son build dans les heartbeats.

---

## 23. Temps réel par Server-Sent Events

### 23.1 Endpoints

- `/api/device/stream` pour un compteur ;
- `/api/events/:eventId/stream` pour superviseur/admin.

### 23.2 Headers

Au minimum :

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
```

Ajouter les headers anti-buffering appropriés aux reverse proxies lorsque nécessaire.

### 23.3 Heartbeat

Émettre un commentaire/heartbeat toutes les 15 à 30 secondes pour maintenir la connexion et détecter les ruptures.

### 23.4 Types d'événements

#### `state`

État compact autoritatif :

```json
{
  "version": 1842,
  "eventStatus": "live",
  "eventOccupancy": 1247,
  "eventCapacity": 1500,
  "spaces": [
    {"id":"...","occupancy":281,"capacity":300}
  ],
  "serverTimeMs": 1788026400000
}
```

#### `event-status`

Changement de statut, fermeture, etc.

#### `device-status`

Flux admin : présence d'appareils, pas de secrets.

#### `notice`

Message opérationnel non métier.

### 23.5 Coalescing

Un tap reçoit toujours son ACK HTTP immédiatement, mais les broadcasts SSE peuvent être coalescés, par exemple sur une fenêtre de 50 à 100 ms, afin d'éviter de rafraîchir 40 fois/seconde tous les dashboards lors d'une pointe.

### 23.6 Reconnexion

À chaque connexion/reconnexion, le serveur envoie un `state` complet. Aucun mécanisme complexe de replay n'est requis P0.

---

## 24. API HTTP — conventions

### 24.1 Base

`/api/v1`

### 24.2 Erreurs

Format uniforme inspiré `application/problem+json` :

```json
{
  "type": "https://example.invalid/problems/event-not-live",
  "title": "Event not live",
  "status": 409,
  "code": "EVENT_NOT_LIVE",
  "detail": "Counting is disabled for this event.",
  "requestId": "req-..."
}
```

### 24.3 Endpoints principaux

#### Initialisation / auth

- `GET /api/v1/meta`
- `POST /api/v1/setup`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/session`

#### Événements

- `GET /api/v1/events`
- `POST /api/v1/events`
- `GET /api/v1/events/:id`
- `PATCH /api/v1/events/:id`
- `POST /api/v1/events/:id/start`
- `POST /api/v1/events/:id/begin-closing`
- `POST /api/v1/events/:id/close`
- `POST /api/v1/events/:id/reopen` (admin)
- `POST /api/v1/events/:id/archive`

#### Topologie

- CRUD espaces en draft ;
- CRUD checkpoints en draft ;
- endpoint `validate-topology`.

#### Appareils

- `POST /api/v1/events/:id/device-invites`
- `DELETE /api/v1/device-invites/:id`
- `GET /api/v1/events/:id/devices`
- `PATCH /api/v1/device-sessions/:id`
- `POST /api/v1/device-sessions/:id/revoke`

#### Pairing et compteur

- `POST /api/v1/device/pair`
- `GET /api/v1/device/bootstrap`
- `POST /api/v1/device/actions/batch`
- `POST /api/v1/device/heartbeat`
- `GET /api/v1/device/stream`

#### Supervision

- `GET /api/v1/events/:id/state`
- `GET /api/v1/events/:id/stream`
- `POST /api/v1/events/:id/adjustments`
- `GET /api/v1/events/:id/movements`
- `GET /api/v1/events/:id/analytics`

#### Export/système

- `GET /api/v1/events/:id/export/movements.csv`
- `GET /api/v1/events/:id/export/event.json`
- `POST /api/v1/system/backups`
- `GET /api/v1/system/backups`
- `GET /health/live`
- `GET /health/ready`

### 24.4 OpenAPI

Générer un schéma OpenAPI depuis les schemas de routes. Swagger UI peut être activé seulement en développement ou derrière authentification admin.

---

## 25. Authentification et sessions

### 25.1 Mots de passe humains

Hash Argon2id avec paramètres au moins conformes aux recommandations OWASP actuelles. Les valeurs doivent rester configurables si la bibliothèque évolue.

Jamais de SHA-256 pour un mot de passe.

### 25.2 Tokens de session

Pour staff et appareils :

- `crypto.randomBytes(32)` ou plus ;
- encodage base64url ;
- cookie contenant le secret aléatoire ;
- base SQLite contenant seulement `SHA-256(token)` ;
- comparaison constante lorsque pertinent.

SHA-256 est approprié ici car le token possède déjà une forte entropie ; il ne remplace pas Argon2id pour les mots de passe.

### 25.3 Cookies

En production HTTPS :

- `Secure` ;
- `HttpOnly` ;
- `SameSite=Strict` ;
- `Path=/` ;
- aucun `Domain` ;
- préfixe `__Host-`.

Deux cookies distincts peuvent être utilisés : staff et device.

En développement localhost HTTP, utiliser des noms de cookies de développement sans `__Host-`.

### 25.4 Durée

- staff : expiration absolue typique 12 à 24 h, renouvellement contrôlé ;
- device : jusqu'à fin événement + marge de synchronisation, révocable ;
- invitation : courte, défaut 30 min.

### 25.5 Déconnexion/révocation

Révocation en base immédiate. Les connexions SSE associées sont fermées dès que possible.

---

## 26. CSRF, CORS et origine

### 26.1 Même origine

Frontend, API et SSE doivent être servis par le même origin en production.

Pas de CORS public.

### 26.2 CSRF staff

Comme les cookies sont automatiques, protéger les mutations staff avec un token CSRF synchronizer :

- secret aléatoire lié à la session ;
- valeur lisible via endpoint de bootstrap après authentification ;
- envoyée en header `X-CSRF-Token` ;
- jamais dans une URL.

Ajouter `SameSite=Strict` et validation `Origin`/Fetch Metadata comme défense en profondeur.

### 26.3 Device API

Même principe pour les POST appareil, ou token CSRF de session appareil fourni au bootstrap. Le fait que les actions soient idempotentes ne remplace pas la protection CSRF.

### 26.4 SSE

GET authentifié par cookie, même origine, CORS fermé. Aucune action métier reçue via SSE.

---

## 27. Sécurité HTTP

### 27.1 Headers

Configurer via Helmet/Fastify, puis vérifier :

- `Content-Security-Policy` restrictive ;
- `Strict-Transport-Security` lorsque HTTPS permanent ;
- `X-Content-Type-Options: nosniff` ;
- `Referrer-Policy: no-referrer` ;
- `frame-ancestors 'none'` / protection clickjacking ;
- `Permissions-Policy` désactivant caméra, micro, géolocalisation si non utilisées ;
- suppression de signatures inutiles (`X-Powered-By`).

### 27.2 CSP cible

Aucune ressource externe nécessaire. Le CSP doit viser `self` et éviter `unsafe-eval`/`unsafe-inline` si possible.

### 27.3 Validation

Tous les inputs ont :

- schema strict ;
- limites de taille ;
- longueur maximale ;
- enums ;
- prepared statements via ORM/driver ;
- échappement naturel React pour affichage.

### 27.4 Rate limiting

Valeurs initiales à mesurer :

- login : très strict par IP + username ;
- pairing : strict par IP ;
- actions compteur : tolérer les bursts humains, par exemple plusieurs dizaines/s/appareil sans bloquer un usage normal ;
- exports/admin lourds : limités ;
- taille body globale faible.

Cloudflare peut ajouter un edge rate limit, mais le serveur possède ses propres protections.

### 27.5 Logs

Ne jamais logguer :

- cookies ;
- session tokens ;
- QR secrets ;
- mots de passe ;
- CSRF tokens ;
- payloads complets contenant des secrets.

---

## 28. Menaces principales et mitigations

### Spoofing

Risque : QR volé, session appareil copiée.  
Mitigation : token fort, usage unique, expiration, cookie HttpOnly, révocation.

### Tampering

Risque : fausses requêtes.  
Mitigation : auth, CSRF, validation, checkpoint lié au serveur, transactions, idempotence.

### Repudiation

Risque : impossible d'expliquer une correction.  
Mitigation : journal immuable + audit staff.

### Information disclosure

Risque limité car aucune donnée visiteur nominative.  
Mitigation : données minimales, aucun SaaS, logs nettoyés, TLS.

### Denial of Service

Risque : flood HTTP/SSE.  
Mitigation : Cloudflare optionnel, rate limits, limites de body, max connexions, timeout, health checks.

### Elevation of privilege

Risque : compteur accédant à l'admin.  
Mitigation : sessions et middleware de rôle séparés, tests d'autorisation systématiques.

---

## 29. Vie privée / RGPD

### 29.1 Visiteurs

Ne collecter :

- ni nom ;
- ni email ;
- ni identifiant de billet ;
- ni image ;
- ni géolocalisation ;
- ni identifiant publicitaire.

Un mouvement représente « une personne a traversé ce checkpoint », pas « quelle personne ».

### 29.2 Staff

Compte humain minimal : username, rôle, hash de mot de passe, timestamps techniques.

### 29.3 IP et user-agent

Éviter de persister les IP dans la base sauf nécessité documentée. Les rate limits peuvent utiliser l'IP en mémoire. Si un besoin de sécurité impose une conservation, prévoir rétention courte et information correspondante.

Ne pas stocker de user-agent complet si `app_version` et un label d'appareil suffisent.

### 29.4 Télémétrie

Aucune télémétrie externe par défaut. Pas de Google Analytics, Sentry, CDN tiers ou pixels.

---

## 30. Sauvegardes et restauration

### 30.1 Méthode

Utiliser l'API de backup SQLite via `better-sqlite3`, pas une copie naïve du fichier `.db` en ignorant le WAL.

### 30.2 Politique par défaut

Pendant `live`/`closing` : sauvegarde toutes les 5 minutes.  
Hors live : intervalle plus long ou sauvegarde avant opération sensible.

### 30.3 Déclencheurs obligatoires

- avant migration ;
- au passage en live ;
- périodiquement pendant live ;
- à la fermeture ;
- à la demande admin.

### 30.4 Validation de sauvegarde

Après création :

- hash SHA-256 ;
- ouverture de la copie ;
- `PRAGMA quick_check` ;
- taille non nulle ;
- enregistrement dans `backup_records`.

### 30.5 Rétention

Valeur configurable. Une valeur initiale de 300 sauvegardes est acceptable compte tenu de la faible taille attendue.

### 30.6 Restauration

Processus offline documenté :

1. arrêter le conteneur ;
2. sauvegarder la base courante ;
3. restaurer une copie validée ;
4. relancer ;
5. exécuter checks DB ;
6. **invalider toutes les sessions staff/device restaurées** par mesure de sécurité ;
7. vérifier la version de schéma.

La restauration depuis l'UI n'est pas obligatoire P0 ; une CLI documentée peut être plus sûre.

---

## 31. Observabilité et santé

### 31.1 Logs

Pino/Fastify JSON sur stdout en production.

Inclure :

- requestId ;
- route ;
- status ;
- durée ;
- événement/checkpoint par ID lorsque utile ;
- erreurs métier par code ;
- sauvegardes ;
- migrations ;
- fermeture propre.

### 31.2 `/health/live`

Répond si le processus peut servir HTTP.

### 31.3 `/health/ready`

Vérifie :

- DB ouverte ;
- `SELECT 1` ;
- dossier data writable ;
- migrations à jour.

Ne pas exposer de détails sensibles publiquement.

### 31.4 Panneau système admin

Afficher :

- version application ;
- version schema ;
- taille DB ;
- taille WAL ;
- espace disque libre ;
- dernière sauvegarde ;
- résultat du dernier `quick_check` ;
- nombre de flux SSE actifs ;
- nombre d'appareils online/offline ;
- uptime.

---

## 32. Déploiement Docker

### 32.1 Objectif

Le chemin minimal doit ressembler à :

```bash
docker run -d \
  --name paxflux \
  -p 3000:3000 \
  -v paxflux-data:/data \
  -v paxflux-backups:/backups \
  ghcr.io/OWNER/paxflux:latest
```

Puis ouverture de `http://localhost:3000`.

### 32.2 Image

- multi-stage build ;
- Node 24 LTS Debian slim, version explicite ;
- installation reproductible `npm ci` ;
- build web puis backend ;
- aucune dev dependency dans l'image finale ;
- processus utilisateur non root ;
- `/data` et `/backups` préparés avec permissions correctes ;
- signal SIGTERM géré ;
- healthcheck.

### 32.3 Un seul process

Le backend sert :

- API ;
- SSE ;
- fichiers statiques PWA.

Pas de Nginx obligatoire dans le conteneur.

### 32.4 Compose de référence

Le dépôt fournit un `docker-compose.yml` simple.

Hardening recommandé :

- `restart: unless-stopped` ;
- root filesystem read-only si compatible ;
- `tmpfs: /tmp` ;
- `cap_drop: ALL` ;
- `no-new-privileges:true` ;
- volumes explicites ;
- port lié à loopback quand un tunnel/reverse proxy est utilisé.

---

## 33. Cloudflare — couche optionnelle

### 33.1 Principe

Cloudflare n'est pas dans le conteneur applicatif principal.

```text
Internet
   ↓
Cloudflare
   ↓
cloudflared (sidecar ou host)
   ↓
app:3000
```

### 33.2 Tunnel

Cloudflare Tunnel crée une connexion sortante et évite d'exposer directement un port public.

### 33.3 SSE

SSE repose sur une réponse HTTP longue. Ajouter `Cache-Control: no-cache, no-transform`. Si une latence de buffering apparaît à travers Cloudflare, créer une règle ciblée sur les endpoints `/stream` pour désactiver le response body buffering, tout en comprenant l'impact éventuel sur l'inspection WAF de cette route.

### 33.4 Cache

- ne jamais mettre en cache `/api/*` ;
- ne pas mettre en cache les flux SSE ;
- assets hashés statiques : cache long possible ;
- service worker et index : règles prudentes.

### 33.5 Proxy trust

`trustProxy` Fastify doit être explicitement configuré selon le mode de déploiement. Ne jamais faire confiance aveuglément à des headers `X-Forwarded-*` lorsque le serveur est directement exposé.

---

## 34. Configuration environnement

Variables minimales suggérées :

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
DATA_DIR=/data
BACKUP_DIR=/backups
PUBLIC_BASE_URL=https://count.example.org
TZ=Europe/Paris
LOG_LEVEL=info
TRUST_PROXY=false
BACKUP_INTERVAL_LIVE_MINUTES=5
BACKUP_RETENTION_COUNT=300
PAIRING_TTL_MINUTES=30
STAFF_SESSION_HOURS=12
DEVICE_SESSION_GRACE_HOURS=24
ENABLE_SWAGGER=false
```

Pas de mot de passe admin dans l'environnement.

Le secret Cloudflare, s'il existe, appartient au sidecar `cloudflared`, pas à l'application.

---

## 35. Migrations

### 35.1 Drizzle migrations

- SQL versionné dans Git ;
- jamais `push` de schéma ad hoc en production ;
- migration à l'initialisation avant écoute réseau ;
- backup automatique avant toute migration d'une base existante.

### 35.2 Échec

Si une migration échoue :

- startup en échec ;
- aucun serveur partiellement fonctionnel ;
- log explicite ;
- backup pré-migration conservé.

### 35.3 Downgrade

Aucun downgrade automatique. Documenter la restauration de backup avec image applicative correspondante.

---

## 36. Structure de dépôt recommandée

```text
/
├─ apps/
│  ├─ web/
│  │  ├─ src/
│  │  │  ├─ app/
│  │  │  ├─ counter/
│  │  │  ├─ admin/
│  │  │  ├─ components/
│  │  │  ├─ offline/
│  │  │  └─ styles/
│  │  └─ vite.config.ts
│  └─ server/
│     └─ src/
│        ├─ app.ts
│        ├─ server.ts
│        ├─ config/
│        ├─ db/
│        ├─ domain/
│        ├─ auth/
│        ├─ routes/
│        ├─ realtime/
│        ├─ backups/
│        └─ cli/
├─ packages/
│  └─ shared/
│     ├─ contracts/
│     ├─ types/
│     └─ constants/
├─ drizzle/
├─ docs/
│  ├─ architecture.md
│  ├─ operations.md
│  ├─ security.md
│  ├─ deployment.md
│  └─ adr/
├─ tests/
│  ├─ e2e/
│  ├─ load/
│  └─ fixtures/
├─ .github/workflows/
├─ Dockerfile
├─ docker-compose.yml
├─ docker-compose.cloudflare.yml
├─ .env.example
├─ package.json
├─ package-lock.json
├─ README.md
├─ CONTRIBUTING.md
├─ SECURITY.md
├─ CHANGELOG.md
└─ LICENSE
```

Utiliser npm workspaces pour éviter un gestionnaire supplémentaire.

---

## 37. Architecture interne backend

### 37.1 Couches

#### Routes

Transport HTTP uniquement : validation, auth middleware, mapping DTO.

#### Domain services

Règles métier : mouvements, transitions, status, corrections, topologie.

#### Repositories

Accès SQLite/Drizzle.

#### Realtime broadcaster

Reçoit des événements **après commit** et diffuse l'état compact.

#### Background jobs internes

- backup timer ;
- cleanup sessions expirées ;
- cleanup invitations ;
- éventuellement checkpoint/maintenance DB.

Pas de scheduler externe.

### 37.2 Transactions

Aucun broadcast SSE avant COMMIT.

Aucun `await` réseau ou opération longue dans une transaction SQLite.

---

## 38. Frontend — séparation des responsabilités

### 38.1 Counter shell

Optimisé :

- bundle léger ;
- navigation minimale ;
- IndexedDB ;
- SSE ;
- optimistic display ;
- priorité au tactile.

### 38.2 Admin shell

- dashboard responsive ;
- topologie ;
- appareils ;
- historique ;
- analytics ;
- système.

### 38.3 État

- TanStack Query pour serveur ;
- petit store local uniquement si nécessaire ;
- IndexedDB comme persistance outbox ;
- éviter un store global massif.

---

## 39. Calcul de l'état affiché compteur

Pour chaque espace concerné :

```text
displayedOccupancy = lastAuthoritativeServerOccupancy
                     + sum(localPendingDeltasForThisDevice)
```

À chaque nouvel état SSE :

- remplacer la base serveur ;
- ne pas perdre les pending locaux ;
- recomposer l'affichage.

À l'ACK d'un batch :

- supprimer uniquement les actions explicitement reconnues ;
- appliquer l'état serveur de réponse ;
- recalculer avec les pending restants.

---

## 40. Performance et objectifs de service

Le produit n'a pas besoin d'une architecture haute charge, mais doit être testé au-delà du besoin réel.

### 40.1 Charge cible de validation

- 20 appareils réels simultanés ;
- 50 appareils simulés ;
- 100 connexions SSE supportées ;
- burst de 100 actions/s pendant 10 s sur machine de référence ;
- aucune action acceptée perdue ;
- aucune duplication sous retry ;
- pas de lock SQLite persistant.

### 40.2 Latence indicative

Sur LAN/serveur raisonnable :

- ACK action p95 < 250 ms ;
- propagation visuelle aux autres clients p95 < 500 ms ;
- chargement compteur après cache < 2 s.

Ce sont des objectifs de test, pas des garanties réseau Internet.

### 40.3 Indicateur principal

La propriété essentielle est **exactly-once effect under at-least-once delivery** grâce à l'idempotence, pas la latence absolue.

---

## 41. Tests unitaires obligatoires

### Domaine

- entrée extérieur→interne ;
- sortie interne→extérieur ;
- transfert interne→interne ;
- dépassement capacité ;
- jauge négative ;
- agrégation parents ;
- topology cycle detection ;
- checkpoint vers aggregate refusé.

### Idempotence

- même `client_action_id` envoyé 2, 10, 100 fois → effet unique ;
- retry après réponse perdue ;
- duplication dans batch.

### Reversal

- undo d'une action ;
- double reversal direct refusé ;
- original + reversal même batch ;
- reversal d'une action déjà idempotente.

### Ajustements

- +N ;
- -N ;
- motif obligatoire ;
- audit.

### Statuts

- draft bloque taps ;
- live autorise ;
- closing accepte sync et désactive nouvelles actions client connecté ;
- closed bloque ;
- archived lecture seule.

### Auth

- invite expirée/utilisée/révoquée ;
- device révoqué ;
- rôle supervisor/admin ;
- CSRF absent/faux ;
- session expirée.

---

## 42. Tests d'intégration obligatoires

- migration base vide ;
- migration base existante ;
- backup avant migration ;
- transaction mouvement + `space_state` + version ;
- crash simulé/restart ;
- `PRAGMA quick_check` ;
- 20 clients concurrents ;
- batch offline 100 actions ;
- SSE reconnexion ;
- coalescing ;
- fermeture avec appareils hors ligne ;
- export CSV protégé contre formula injection ;
- restore et invalidation sessions.

---

## 43. Tests E2E Playwright

Scénario de référence :

1. première installation ;
2. création admin ;
3. création événement capacité 100 ;
4. espaces Site/VIP ;
5. checkpoints Porte A et VIP ;
6. création invitation ;
7. appairage contexte mobile ;
8. démarrage événement ;
9. +10 sur appareil A ;
10. second appareil +5 ;
11. dashboard = 15 ;
12. appareil A offline ;
13. +3 local ;
14. dashboard signale appareil offline ;
15. retour online ;
16. sync ;
17. dashboard = 18 ;
18. transfert 2 vers VIP, total reste 18 ;
19. undo ;
20. correction superviseur ;
21. dépassement capacité test ;
22. passage closing ;
23. fermeture ;
24. export ;
25. reboot serveur ;
26. état conservé.

Viewports :

- mobile ~390×844 ;
- desktop ~1440×900.

---

## 44. Tests de résilience / chaos

- couper le réseau après envoi mais avant ACK ;
- tuer le conteneur pendant un burst ;
- redémarrer avec WAL présent ;
- disque presque plein ;
- session révoquée pendant offline ;
- Cloudflare/tunnel indisponible ;
- SSE coupé puis reconnecté ;
- service worker avec build ancien ;
- double tap rapide ;
- changement d'orientation écran ;
- navigateur fermé avec outbox puis rouvert.

---

## 45. Tests sécurité

- CSRF depuis origin hostile ;
- CORS non autorisé ;
- tentative d'IDOR entre événements ;
- compteur appelant routes admin ;
- brute force login/pairing ;
- XSS via nom événement/checkpoint/motif ;
- SQL injection ;
- oversized JSON ;
- headers de sécurité ;
- cookies flags ;
- QR utilisé deux fois ;
- setup endpoint après initialisation ;
- session token absent des logs ;
- CSV injection.

Utiliser OWASP ZAP en scan passif/automatisé si pratique, sans bloquer le développement initial.

---

## 46. CI/CD GitHub

### Pull Request

- `npm ci` ;
- lint ;
- format check ;
- typecheck ;
- unit ;
- integration ;
- build web/server ;
- Playwright smoke ;
- dependency review.

### Tag/release

- build Docker multi-arch si possible (`amd64`, `arm64`) ;
- scan image ;
- SBOM ;
- push GHCR ;
- release notes ;
- version semver.

### Dépendances

Activer Dependabot ou Renovate. Ne pas auto-merger des changements majeurs sans tests.

### GitHub Actions

Permissions minimales (`contents: read` par défaut), actions épinglées de manière raisonnable et secrets non exposés aux PR non fiables.

---

## 47. Versioning

SemVer :

- `0.x` pendant développement ;
- `1.0.0` après premier événement validé et procédure de migration stabilisée.

Afficher version et commit/build ID dans l'administration.

Le schéma DB a sa propre version de migration.

---

## 48. Runbook pré-festival

### J-7

- geler les fonctionnalités ;
- déployer release candidate ;
- créer événement réel ;
- vérifier topologie avec organisateurs ;
- test de charge ;
- tester iPhone + Android ;
- tester réseau sur site ;
- vérifier sauvegardes et restauration.

### J-1

- mettre à jour uniquement si nécessaire ;
- sauvegarde ;
- redémarrage propre ;
- `quick_check` ;
- vérifier disque ;
- préparer QR ;
- préparer chargeurs/powerbanks ;
- disposer d'un plan de comptage manuel de secours.

### H-1

- appairer tous les appareils ;
- vérifier écran « prêt offline » ;
- vérifier chaque checkpoint ;
- dashboard tous verts ;
- faire un test contrôlé ;
- revenir à une session propre de production (idéalement événement de test séparé) ;
- aucun déploiement ensuite.

### Pendant

- un superviseur garde le dashboard visible ;
- traiter immédiatement les appareils offline ;
- ne pas modifier la topologie ;
- documenter toute correction ;
- surveiller sauvegarde.

### Fin

- passer `closing` ;
- attendre les resynchronisations ;
- investiguer les appareils offline ;
- fermer ;
- backup final ;
- export CSV/JSON ;
- archiver seulement après contrôle.

---

## 49. Incidents et réponses

| Incident | Comportement attendu | Action superviseur |
|---|---|---|
| 1 téléphone offline | il continue localement | rétablir réseau, ne pas croire la jauge globale parfaite |
| plusieurs téléphones offline | dashboard dégradé/non garanti | passer en procédure terrain de secours |
| serveur redémarre | outboxes persistent, SSE reconnecte | attendre resync, vérifier santé |
| Cloudflare indisponible | clients passent offline | continuer local + fallback manuel si long |
| mauvais tap | undo immédiat | sinon correction supervisée |
| appareil perdu | révoquer session | créer nouveau QR |
| QR photographié | usage unique limite le risque | révoquer invitation/session si doute |
| DB `quick_check` échoue | ready fail / alerte critique | arrêter écritures si nécessaire, restaurer backup |
| disque presque plein | alerte critique | libérer espace, conserver exports/backups sûrs |
| capacité dépassée | système continue d'enregistrer | l'équipe applique sa procédure sécurité réelle |
| événement fermé trop tôt | admin peut réouvrir avec audit | vérifier outboxes avant fermeture définitive |

---

## 50. Limite opérationnelle importante

Cette application mesure ce que les opérateurs saisissent. Elle n'est pas une preuve automatique que la capacité physique réelle est exacte.

Si la jauge est utilisée dans une procédure réglementaire de sécurité, l'organisateur reste responsable :

- du positionnement des compteurs ;
- de la discipline d'utilisation ;
- du réseau ;
- du plan de secours ;
- de la conformité de la méthode aux exigences applicables.

Pour le premier événement, conserver des compteurs mécaniques ou une procédure manuelle comme fallback est recommandé.

---

## 51. Définition de « Done » P0

Le projet n'est pas prêt pour Campulsations tant que tous les points suivants ne sont pas vrais :

### Produit

- [ ] compteur mobile utilisable sans formation longue ;
- [ ] multi-device réel ;
- [ ] multi-checkpoint ;
- [ ] multi-zone ;
- [ ] dashboard live ;
- [ ] capacités/alertes ;
- [ ] corrections ;
- [ ] exports.

### Fiabilité

- [ ] idempotence testée ;
- [ ] outbox IndexedDB testée ;
- [ ] retry après ACK perdu testée ;
- [ ] restart serveur testée ;
- [ ] fermeture `closing` testée ;
- [ ] backup/restore testés ;
- [ ] DB quick_check.

### Sécurité

- [ ] first-run setup token ;
- [ ] Argon2id ;
- [ ] cookies HttpOnly/Secure/SameSite ;
- [ ] CSRF ;
- [ ] RBAC ;
- [ ] rate limit ;
- [ ] security headers ;
- [ ] secrets absents des logs ;
- [ ] container non-root.

### Déploiement

- [ ] `docker run` fonctionne ;
- [ ] `docker compose up -d` fonctionne ;
- [ ] volume persistant ;
- [ ] image GHCR ;
- [ ] healthcheck ;
- [ ] documentation Cloudflare ;
- [ ] documentation restore.

### Tests terrain

- [ ] au moins 10 téléphones en répétition ;
- [ ] iOS + Android ;
- [ ] test réseau sur lieu ;
- [ ] scénario offline/reconnect ;
- [ ] procédure de secours comprise par l'équipe.

---

## 52. Priorisation

### P0 — obligatoire avant festival

- monolithe Docker ;
- first-run sécurisé ;
- auth staff ;
- event/spaces/checkpoints ;
- pairing QR ;
- compteur ;
- idempotence ;
- offline outbox ;
- SSE ;
- dashboard ;
- corrections ;
- closing ;
- CSV/JSON ;
- backups ;
- tests critiques ;
- docs opérationnelles.

### P1 — très utile après cœur stable

- duplication événement ;
- analytics enrichies ;
- impression batch de QR ;
- i18n anglais ;
- thème/branding configurable ;
- rapport PDF ;
- CLI doctor complète ;
- image arm64 validée ;
- import/export configuration.

### P2 — seulement après retour terrain

- serveur local « appliance mode » pour survivre à une panne Internet totale avec réseau local ;
- notifications browser ;
- prévisions de saturation explicitement expérimentales ;
- multi-site/multi-instance ;
- intégration billetterie ;
- API publique documentée ;
- OIDC/SSO institutionnel.

---

## 53. ADR à créer dans le dépôt

### ADR-001 — Modular monolith

Un seul processus Fastify sert frontend, API et temps réel.

### ADR-002 — SQLite WAL local

SQLite plutôt qu'un serveur PostgreSQL pour réduire l'exploitation.

### ADR-003 — SSE over WebSocket

Push serveur uniquement ; écritures HTTP.

### ADR-004 — Append-only movement ledger

Le mouvement est source de vérité, `space_state` est matérialisé.

### ADR-005 — PWA IndexedDB outbox

Offline client persistant, sans dépendre de Background Sync.

### ADR-006 — Stateful HttpOnly sessions

Pas de JWT/localStorage.

### ADR-007 — Cloudflare optional edge

Core indépendant du fournisseur.

### ADR-008 — No deploy during live

Politique d'exploitation et gestion service worker.

---

## 54. Décisions à ne pas rouvrir sans raison mesurée

Pour éviter qu'un agent de code ne complexifie le projet :

- ne pas remplacer SQLite par Postgres « pour scaler » ;
- ne pas ajouter Redis ;
- ne pas convertir en microservices ;
- ne pas migrer vers Next.js juste pour la mode ;
- ne pas remplacer SSE par WebSocket sans contrainte réelle ;
- ne pas faire de JWT frontend ;
- ne pas ajouter de SaaS de données ;
- ne pas ajouter d'IA ;
- ne pas introduire de sync P2P ;
- ne pas sacrifier l'audit pour simplifier les corrections ;
- ne pas cacher les états offline/incohérents.

---

## 55. Critères de revue UX avant code final

Le produit doit être testé par une personne n'ayant jamais vu l'application.

Objectifs :

- appairage < 30 s après scan QR ;
- comprendre les deux boutons sans explication ;
- faire 20 taps rapides sans erreur UI ;
- comprendre immédiatement « hors ligne » ;
- superviseur trouve un appareil déconnecté en < 15 s ;
- correction de jauge en < 30 s ;
- fermeture impossible « par accident ».

---

## 56. Références techniques vérifiées au 29 août 2026

1. **CROUS Bordeaux — cahier des charges transmis, 2 juillet 2026.** Besoin : jauge temps réel, entrées/sorties, plusieurs zones, plusieurs téléphones, historique et dashboard.
2. **SQLite — Write-Ahead Logging.** WAL permet lectures et écriture concurrentes sur une même machine, avec un seul writer ; ne pas utiliser le WAL actif sur filesystem réseau. https://www.sqlite.org/wal.html
3. **better-sqlite3 — performance guidance.** Recommande WAL pour les applications web et permet `synchronous=FULL`. https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md
4. **SQLite Online Backup API / better-sqlite3 backup.** Backup cohérent pendant utilisation. https://www.sqlite.org/backup.html et https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
5. **Fastify 5 ecosystem.** `@fastify/sse` est un plugin officiel ; Fastify fournit validation schema et TypeScript. https://fastify.dev/docs/latest/Guides/Ecosystem/
6. **Cloudflare Tunnel.** Connexion sortante vers Cloudflare sans IP publique obligatoire. https://developers.cloudflare.com/tunnel/
7. **Cloudflare HTTP/SSE et buffering.** Cloudflare documente les flux SSE et permet le contrôle du response body buffering. https://developers.cloudflare.com/agents/runtime/communication/http-sse/ et https://developers.cloudflare.com/rules/configuration-rules/settings/
8. **OWASP Password Storage Cheat Sheet.** Argon2id recommandé. https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
9. **OWASP Session Management / CSRF / HTTP Headers.** Cookies Secure/HttpOnly/SameSite, défense CSRF et headers modernes. https://cheatsheetseries.owasp.org/
10. **MDN IndexedDB / Background Sync.** IndexedDB adapté au stockage offline ; Background Sync n'est pas Baseline sur tous les navigateurs. https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API et https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API
11. **Node.js releases.** Node 24 est LTS au 29 août 2026 ; Node 26 est encore Current. https://nodejs.org/en/about/previous-releases
12. **Google Antigravity 2.0.** Plateforme desktop agent-first capable d'orchestrer plusieurs agents en parallèle. https://antigravity.google/blog/introducing-google-antigravity-2

---

# Annexe A — exemple de topologie Campulsations

```text
                              [ EXTÉRIEUR ]
                                  │   │
                          Porte A │   │ Porte B
                                  ▼   ▼
                         [ ZONE GÉNÉRALE ]
                           │             │
                    VIP ⇅  │             │ ⇅ Salle A
                           │             │
                         [ VIP ]       [ SALLE A ]
                           │
                           │ ⇅ Terrasse VIP
                           ▼
                       [ TERRASSE ]
```

La jauge événement = somme des feuilles internes.

---

# Annexe B — exemple d'action locale

```json
{
  "clientActionId": "8bd5b8d1-4a74-4c21-85b0-bb7f5ddc1ae4",
  "sequence": 417,
  "type": "count",
  "direction": "a_to_b",
  "clientCreatedAtMs": 1788026400123
}
```

Reversal :

```json
{
  "clientActionId": "e169b99d-3b1c-4a3f-a595-5c3f3287c2e2",
  "sequence": 418,
  "type": "reversal",
  "targetClientActionId": "8bd5b8d1-4a74-4c21-85b0-bb7f5ddc1ae4",
  "clientCreatedAtMs": 1788026401020
}
```

---

# Annexe C — exemple de réponse batch

```json
{
  "acknowledged": [
    {
      "clientActionId": "8bd5b8d1-4a74-4c21-85b0-bb7f5ddc1ae4",
      "status": "applied",
      "movementId": 18442
    }
  ],
  "state": {
    "version": 1842,
    "eventOccupancy": 1248,
    "eventCapacity": 1500,
    "eventStatus": "live"
  }
}
```

---

# Annexe D — philosophie de maintenance

Le code doit rester explicite, testable et lisible par un futur mainteneur n'ayant pas participé au projet. Toute abstraction nouvelle doit répondre à un besoin observé, pas à une anticipation abstraite de croissance.

Le succès du projet est qu'une équipe non technique puisse l'utiliser pendant un festival, puis qu'une autre personne puisse le redéployer plusieurs mois plus tard avec `docker compose up -d` et une documentation courte.
