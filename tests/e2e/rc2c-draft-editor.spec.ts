import { test, expect, Page } from '@playwright/test';
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  AdminSession,
  adminApi,
  DraftEventTopology,
  createDeviceInviteToken,
  createDraftEventWithMainCheckpoint,
  getAdminSession,
  getEventCheckpoints,
  getEventDevices,
  getEventSpaces,
  getEventState,
  revokeDeviceSession,
  startEvent,
} from './helpers.js';

/**
 * RC2-C — a draft is preparation, and preparation is editable.
 *
 * The field failure: an event could be created and then only started. A
 * capacity typed wrong, a zone misspelled, a door wired to the wrong side —
 * none of it could be corrected in the product. The only "edit" available
 * was to delete the event and build it again, which is not an edit: it
 * throws away every id the rest of the system points at.
 *
 * These scenarios drive the real screens against the real API. What they
 * assert is that the change *persisted* — re-read from the server after a
 * reload — not that a form accepted a keystroke.
 */

let session: AdminSession;

test.beforeAll(async () => {
  session = await getAdminSession();
});

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('admin').fill(ADMIN_USERNAME);
  await page.getByPlaceholder('••••••••••••').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Connexion' }).click();
  await page.waitForURL('**/admin');
}

/** A fresh draft, named for the project so parallel viewports never collide. */
async function draft(name: string): Promise<DraftEventTopology> {
  return createDraftEventWithMainCheckpoint(session, {
    name: `${name} · ${test.info().project.name}`,
    capacity: 500,
  });
}

/** One extra leaf zone, so a door has somewhere else to be moved to. */
async function addZone(eventId: string, name: string, capacity: number): Promise<{ id: string }> {
  return adminApi(session, 'POST', `/api/v1/events/${eventId}/spaces`, { name, kind: 'leaf', capacity });
}

async function openEditor(page: Page, eventId: string): Promise<void> {
  await page.goto(`/admin/events/${eventId}/edit`);
  await expect(page.getByRole('heading', { name: 'Modifier le brouillon' })).toBeVisible();
}

/** Waits for the editor's own confirmation that the server took the change. */
async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('draft-save-state')).toContainText('Enregistré à', { timeout: 15_000 });
}

test('l’éditeur de brouillon est accessible depuis la supervision et corrige l’événement', async ({ page }) => {
  const topo = await draft('RC2C Édition événement');

  await loginAsAdmin(page);
  await page.goto(`/admin?event=${topo.eventId}`);

  // Discoverability is part of the fix: the action lives where a preflight
  // verdict is read, not behind a URL only this test knows.
  const editLink = page.getByRole('link', { name: 'Modifier le brouillon' });
  await expect(editLink).toBeVisible();
  await editLink.click();
  await page.waitForURL(`**/admin/events/${topo.eventId}/edit`);

  await page.getByLabel('Nom de l’événement').fill('Nom corrigé sur place');
  await page.getByLabel('Capacité maximale').fill('742');
  await page.getByRole('button', { name: 'Enregistrer l’événement' }).click();
  await expectSaved(page);

  // The server, not the form, is asked what happened.
  const state = await getEventState(session, topo.eventId);
  expect(state.event.name).toBe('Nom corrigé sur place');
  expect(state.event.capacity).toBe(742);

  // And it survives a reload, which is what "persisted" means to an operator.
  await page.reload();
  await expect(page.getByLabel('Nom de l’événement')).toHaveValue('Nom corrigé sur place');
  await expect(page.getByLabel('Capacité maximale')).toHaveValue('742');
});

test('renommer une zone conserve son identifiant au lieu de la recréer', async ({ page }) => {
  const topo = await draft('RC2C Renommage zone');
  const before = await getEventSpaces(session, topo.eventId);
  const siteBefore = before.find((s: any) => s.id === topo.siteSpaceId);

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  await page.getByLabel(`Nom de la zone ${siteBefore.name}`).fill('Esplanade renommée');
  await page.getByRole('button', { name: 'Enregistrer la zone' }).first().click();
  await expectSaved(page);

  const after = await getEventSpaces(session, topo.eventId);
  const siteAfter = after.find((s: any) => s.name === 'Esplanade renommée');

  // The identity assertion is the whole point: a delete-and-recreate would
  // pass a name check and still break every invite and paired session that
  // points at this space.
  expect(siteAfter.id).toBe(topo.siteSpaceId);
  expect(after).toHaveLength(before.length);

  // The door that pointed at it still points at it — nothing was rewired.
  const checkpoints = await getEventCheckpoints(session, topo.eventId);
  const main = checkpoints.find((c: any) => c.id === topo.mainCheckpointId);
  expect(main.spaceBId).toBe(topo.siteSpaceId);
});

test('ajouter puis supprimer une zone modifie la topologie du brouillon', async ({ page }) => {
  const topo = await draft('RC2C Ajout suppression zone');

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  await page.getByRole('button', { name: 'Ajouter une zone' }).click();
  await expectSaved(page);

  let spaces = await getEventSpaces(session, topo.eventId);
  const added = spaces.find((s: any) => s.name === 'Nouvelle zone');
  expect(added).toBeDefined();

  await page.getByRole('button', { name: 'Supprimer la zone Nouvelle zone' }).click();
  await expectSaved(page);

  spaces = await getEventSpaces(session, topo.eventId);
  expect(spaces.find((s: any) => s.name === 'Nouvelle zone')).toBeUndefined();
  // Nothing else moved.
  expect(spaces.map((s: any) => s.id).sort()).toEqual([topo.externalSpaceId, topo.siteSpaceId].sort());
});

test('déplacer une extrémité de porte réécrit le sens du mouvement, pas seulement un libellé', async ({ page }) => {
  const topo = await draft('RC2C Déplacement extrémité');

  // A third endpoint to move the door onto.
  const vip = await addZone(topo.eventId, 'Terrasse VIP', 80);

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  await page
    .getByLabel('Deuxième zone de la porte Porte Principale')
    .selectOption({ label: 'Terrasse VIP' });
  await page.getByRole('button', { name: 'Enregistrer la porte' }).click();
  await expectSaved(page);

  const checkpoints = await getEventCheckpoints(session, topo.eventId);
  const main = checkpoints.find((c: any) => c.id === topo.mainCheckpointId);

  // Same door, different end: the id is stable, the endpoint is not.
  expect(main.id).toBe(topo.mainCheckpointId);
  expect(main.spaceAId).toBe(topo.externalSpaceId);
  expect(main.spaceBId).toBe(vip.id);
});

test('un sens de passage se décrit « De X vers Y », jamais « A → B »', async ({ page }) => {
  const topo = await draft('RC2C Formulation des sens');
  const spaces = await getEventSpaces(session, topo.eventId);
  const site = spaces.find((s: any) => s.id === topo.siteSpaceId);

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  await expect(
    page.getByText(`De Extérieur vers ${site.name}`, { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(`De ${site.name} vers Extérieur`, { exact: true })
  ).toBeVisible();

  // The wire's vocabulary must not leak into the form.
  await expect(page.getByText('Espace A', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Espace B', { exact: true })).toHaveCount(0);
});

test('le sentinelle extérieur est présenté comme une frontière, sans jauge à remplir', async ({ page }) => {
  const topo = await draft('RC2C Sentinelle extérieure');

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  await expect(page.getByTestId('external-space')).toHaveText('Extérieur — frontière de comptage');

  // It offers no capacity field, because it holds nobody.
  await expect(page.getByLabel('Capacité de la zone Extérieur')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Supprimer la zone Extérieur' })).toHaveCount(0);
});

test('une zone encore utilisée par une porte ne peut pas être supprimée, et le refus est affiché', async ({ page }) => {
  const topo = await draft('RC2C Dépendance zone porte');
  const spaces = await getEventSpaces(session, topo.eventId);
  const site = spaces.find((s: any) => s.id === topo.siteSpaceId);

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  await page.getByRole('button', { name: `Supprimer la zone ${site.name}` }).click();

  await expect(page.getByTestId('draft-save-state')).toContainText('Modification non enregistrée', {
    timeout: 15_000,
  });
  // A refusal never reads as a success.
  await expect(page.getByTestId('draft-save-state')).not.toContainText('Enregistré à');

  // And the zone is still there, because it really was not deleted.
  const after = await getEventSpaces(session, topo.eventId);
  expect(after.some((s: any) => s.id === topo.siteSpaceId)).toBe(true);
});

test('une porte appairée refuse un déplacement structurel jusqu’à la révocation de l’appareil', async ({
  page,
  browser,
}) => {
  const topo = await draft('RC2C Sécurité appairage');

  const vip = await addZone(topo.eventId, 'Zone secondaire', 60);

  // Pair a real counter to the door.
  const token = await createDeviceInviteToken(session, topo.eventId, topo.mainCheckpointId);
  const deviceContext = await browser.newContext();
  const devicePage = await deviceContext.newPage();
  await devicePage.goto(`/pair#${token}`);
  await devicePage.waitForURL('**/counter');

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  await page
    .getByLabel('Deuxième zone de la porte Porte Principale')
    .selectOption({ label: 'Zone secondaire' });
  await page.getByRole('button', { name: 'Enregistrer la porte' }).click();

  await expect(page.getByTestId('draft-save-state')).toContainText('Modification non enregistrée', {
    timeout: 15_000,
  });

  // The refusal is the safety property: the paired counter caches this
  // door's endpoints, so moving them under it would silently change what
  // its taps mean. Nothing was migrated.
  let checkpoints = await getEventCheckpoints(session, topo.eventId);
  expect(checkpoints.find((c: any) => c.id === topo.mainCheckpointId).spaceBId).toBe(topo.siteSpaceId);

  // Revoking the pairing is what unblocks it — an explicit operator act.
  const devices = await getEventDevices(session, topo.eventId);
  await revokeDeviceSession(session, devices[0].id);

  await page.reload();
  await page
    .getByLabel('Deuxième zone de la porte Porte Principale')
    .selectOption({ label: 'Zone secondaire' });
  await page.getByRole('button', { name: 'Enregistrer la porte' }).click();
  await expectSaved(page);

  checkpoints = await getEventCheckpoints(session, topo.eventId);
  expect(checkpoints.find((c: any) => c.id === topo.mainCheckpointId).spaceBId).toBe(vip.id);

  await deviceContext.close();
});

test('une modification structurelle rafraîchit le verdict de préparation du serveur', async ({ page }) => {
  const topo = await draft('RC2C Préflight convergent');

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  await expect(page.getByTestId('draft-preflight')).toContainText(
    'Préparation complète : cet événement peut passer en direct.'
  );

  // Removing the only door makes the event unstartable. A structural edit
  // does not bump `event.version`, so nothing but an explicit refetch would
  // have invalidated the verdict above.
  await page.getByRole('button', { name: 'Supprimer la porte Porte Principale' }).click();
  await expectSaved(page);

  await expect(page.getByTestId('draft-preflight')).not.toContainText('Préparation complète');
  // The refusal is the server's verdict, said in the operator's language:
  // `validateEventForLive` phrases it in English for the API and the logs.
  await expect(page.getByTestId('draft-preflight')).toContainText(
    'Ajoutez au moins une porte : sans passage, aucun comptage n’est possible.'
  );
});

test('un événement en direct n’ouvre pas un formulaire d’édition mais un écran de verrouillage', async ({
  page,
}) => {
  const topo = await draft('RC2C Verrouillage direct');
  await startEvent(session, topo.eventId);

  await loginAsAdmin(page);

  // No entry point on the supervision screen for a live event.
  await page.goto(`/admin?event=${topo.eventId}`);
  await expect(page.getByTestId('event-status')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Modifier le brouillon' })).toHaveCount(0);

  // And reaching the route directly says why, rather than offering fields
  // whose every save the server would refuse.
  await page.goto(`/admin/events/${topo.eventId}/edit`);
  await expect(page.getByRole('heading', { name: 'Préparation verrouillée' })).toBeVisible();
  await expect(page.getByText('Cet événement n’est plus un brouillon')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer l’événement' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ajouter une zone' })).toHaveCount(0);
});

test('le fuseau horaire d’un brouillon est corrigeable et validé', async ({ page }) => {
  const topo = await draft('RC2C Fuseau horaire');

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  const field = page.getByLabel('Fuseau horaire');

  // An offset is not a timezone: it carries no DST rules, so an event
  // spanning a transition would report the wrong local hours.
  await field.fill('+05:00');
  await expect(page.getByTestId('timezone-hint')).toContainText('Fuseau horaire inconnu');
  await expect(page.getByRole('button', { name: 'Enregistrer l’événement' })).toBeDisabled();

  await field.fill('America/Guadeloupe');
  await expect(page.getByRole('button', { name: 'Enregistrer l’événement' })).toBeEnabled();
  await page.getByRole('button', { name: 'Enregistrer l’événement' }).click();
  await expectSaved(page);

  const state = await getEventState(session, topo.eventId);
  expect(state.event.timezone).toBe('America/Guadeloupe');
});

test('un brouillon rechargé n’invente aucun lien entre la capacité d’une zone et celle de l’événement', async ({
  page,
}) => {
  // The event and its only zone carry the same number on purpose: the
  // server records two capacities and no relationship between them, so a
  // value-based rule would adopt this zone and overwrite it below.
  const topo = await createDraftEventWithMainCheckpoint(session, {
    name: `RC2C Aucun lien déduit · ${test.info().project.name}`,
    capacity: 500,
  });
  await adminApi(session, 'PATCH', `/api/v1/events/${topo.eventId}/spaces/${topo.siteSpaceId}`, {
    capacity: 500,
  });

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  await page.getByLabel('Capacité maximale').fill('900');
  await page.getByRole('button', { name: 'Enregistrer l’événement' }).click();
  await expectSaved(page);

  const state = await getEventState(session, topo.eventId);
  expect(state.event.capacity).toBe(900);
  expect(
    state.spaces.find((s: any) => s.id === topo.siteSpaceId).capacity,
    'la zone garde la capacité enregistrée'
  ).toBe(500);
});

test('le lien de capacité se demande explicitement, et il s’applique alors', async ({ page }) => {
  const topo = await draft('RC2C Lien explicite');
  const spaces = await getEventSpaces(session, topo.eventId);
  const site = spaces.find((s: any) => s.id === topo.siteSpaceId);

  await loginAsAdmin(page);
  await openEditor(page, topo.eventId);

  // The operator asks for it by name; nothing about the current values
  // decides this for them.
  await page.getByRole('button', { name: 'Même capacité que l’événement' }).click();
  await expect(page.getByLabel(`Capacité de la zone ${site.name}`)).toHaveValue('500');

  await page.getByLabel('Capacité maximale').fill('1200');
  await expect(page.getByLabel(`Capacité de la zone ${site.name}`)).toHaveValue('1200');

  await page.getByRole('button', { name: 'Enregistrer la zone' }).first().click();
  await expectSaved(page);

  const state = await getEventState(session, topo.eventId);
  expect(state.spaces.find((s: any) => s.id === topo.siteSpaceId).capacity).toBe(1200);
});
