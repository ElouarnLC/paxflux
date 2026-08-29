# CLAUDE.md — PaxFlux

## Projet

PaxFlux est une PWA self-hosted de gestion de jauge et de flux de personnes pour événements. Le journal des mouvements est la source de vérité.

Lis avant toute intervention :

1. `PaxFlux_SPECIFICATION_v1.1.md`
2. `PaxFlux_REMEDIATION_PLAN_v1.2.md`
3. `PaxFlux_AGENT_MASTER_PROMPT_v1.2.md`

## Discipline

Ne suppose pas l’état du code. Lis-le.

Avant de modifier :
- reproduis ;
- identifie la cause ;
- lis contrats/types/tests ;
- fais le patch minimal ;
- ajoute le test de non-régression.

Ne masque jamais une erreur par `any`, `catch {}`, suppression de validation ou désactivation de test.

## Invariants

Préserver :
- SQLite autoritaire ;
- journal `movements` append-only ;
- idempotence `clientActionId` ;
- HTTP mutations ;
- SSE push ;
- offline outbox Dexie ;
- QR single-use ;
- sessions HttpOnly ;
- topologie verrouillée en live ;
- transfert interne = delta global 0 ;
- corrections par mouvements compensatoires.

## Priorité actuelle

1. Playwright / tests de reproduction
2. AuthProvider + CSRF reload
3. lifecycle admin + preflight
4. draft cohérent + multi-checkpoints
5. QR + heartbeat
6. offline projection/cache
7. mobile
8. design system
9. CI
10. acceptance

## Git

- branche dédiée ;
- petits commits ;
- un sujet par PR ;
- ne pas pousser directement sur `main`.

## UI

Mobile-first.
Aucun overflow horizontal à 320–412 px.
Ne pas empêcher le zoom.
Utiliser primitives éprouvées plutôt que réinventer Dialog/Select/Menu.
Direction recommandée : shadcn/ui + Radix, adaptée à l’identité PaxFlux.

## Done

Un changement n’est fini que si :
- test de reproduction ajouté ;
- tests ciblés verts ;
- typecheck vert ;
- UI testée mobile si concernée ;
- diff relu ;
- risque résiduel déclaré.

Le build seul n’est jamais une preuve de conformité produit.
