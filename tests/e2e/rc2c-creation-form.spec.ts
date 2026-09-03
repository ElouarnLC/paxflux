import { test, expect, Page } from '@playwright/test';
import { ADMIN_USERNAME, ADMIN_PASSWORD, AdminSession, getAdminSession, getEventState } from './helpers.js';

/**
 * RC2-C — what the creation wizard decides on the operator's behalf.
 *
 * Two field failures, both about a relationship nobody recorded:
 *
 * 1. The event capacity and the first zone's capacity were seeded with the
 *    same number and then drifted apart. Change one at step 1, come back,
 *    and the zone still held the old figure — an event announced at 2 000
 *    whose only zone silently gauged at 1 500.
 *
 * 2. The obvious "fix" — treat equal numbers, or a zone called "Site", as
 *    linked — is worse: it overwrites a capacity the operator deliberately
 *    set the next time the event's changes. So the link is *form state*,
 *    established by where the value came from, never inferred from it.
 *
 * And the timezone was a free-text field defaulting to a constant, which
 * accepts "+05:00" — an offset, carrying no daylight-saving rules, so an
 * event spanning a transition reports the wrong local hours all evening.
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

const eventName = (label: string) => `${label} · ${test.info().project.name}`;

async function openWizard(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto('/admin/events/new');
  await expect(page.getByLabel("Nom de l’événement *")).toBeVisible();
}

const capacityField = (page: Page) => page.getByLabel('Capacité maximale (jauge) *');
const zoneCapacity = (page: Page) => page.getByLabel("Capacité de l’espace");
const next = (page: Page) => page.getByRole('button', { name: 'Suivant' });
const back = (page: Page) => page.getByRole('button', { name: 'Retour' });

test('la capacité de la première zone suit celle de l’événement tant que personne ne l’a fixée', async ({
  page,
}) => {
  await openWizard(page);

  await capacityField(page).fill('2000');
  await next(page).click();
  await expect(zoneCapacity(page).first()).toHaveValue('2000');

  // Still following: nothing has been said about this zone yet.
  await back(page).click();
  await capacityField(page).fill('3500');
  await next(page).click();
  await expect(zoneCapacity(page).first()).toHaveValue('3500');
});

test('une capacité de zone saisie explicitement cesse de suivre l’événement', async ({ page }) => {
  await openWizard(page);

  await capacityField(page).fill('2000');
  await next(page).click();
  await zoneCapacity(page).first().fill('900');

  await back(page).click();
  await capacityField(page).fill('5000');
  await next(page).click();

  // The operator's number survives, which is the whole point of recording
  // where the value came from instead of comparing values.
  await expect(zoneCapacity(page).first()).toHaveValue('900');
});

test('une capacité de zone égale à celle de l’événement n’est jamais interprétée comme un lien', async ({
  page,
}) => {
  await openWizard(page);

  await capacityField(page).fill('2000');
  await next(page).click();

  // Deliberately the same number the event carries: a value-based rule
  // would adopt this zone and then overwrite it below.
  await page.getByRole('button', { name: 'Ajouter un espace intérieur' }).click();
  await page.getByLabel("Nom de l’espace intérieur").nth(1).fill('Salle annexe');
  await zoneCapacity(page).nth(1).fill('2000');

  await back(page).click();
  await capacityField(page).fill('4000');
  await next(page).click();

  await expect(zoneCapacity(page).first(), 'la première zone suit encore').toHaveValue('4000');
  await expect(zoneCapacity(page).nth(1), 'la zone saisie garde sa valeur').toHaveValue('2000');
});

test('les capacités saisies dans l’assistant sont celles qui sont enregistrées', async ({ page }) => {
  await openWizard(page);

  const name = eventName('RC2C Capacités persistées');
  await page.getByLabel("Nom de l’événement *").fill(name);
  await capacityField(page).fill('2600');
  await next(page).click();

  await page.getByLabel("Nom de l’espace intérieur").first().fill('Grande halle');
  await page.getByRole('button', { name: 'Ajouter un espace intérieur' }).click();
  await page.getByLabel("Nom de l’espace intérieur").nth(1).fill('Carré VIP');
  await zoneCapacity(page).nth(1).fill('180');

  await next(page).click();
  await next(page).click();
  await page.getByRole('button', { name: "Créer l’événement (brouillon)" }).click();
  await page.waitForURL('**/admin**');

  const events = await session.api.get('/api/v1/events').then((r) => r.json());
  const created = events.find((e: any) => e.name === name);
  expect(created, 'l’événement a bien été créé').toBeDefined();

  const state = await getEventState(session, created.id);
  expect(state.event.capacity).toBe(2600);
  // The linked zone was carried to the final capacity, the explicit one was not.
  expect(state.spaces.find((s: any) => s.name === 'Grande halle').capacity).toBe(2600);
  expect(state.spaces.find((s: any) => s.name === 'Carré VIP').capacity).toBe(180);
});

test('le fuseau horaire proposé est un identifiant IANA valide, et un décalage est refusé', async ({
  page,
}) => {
  await openWizard(page);

  // Detected from the browser, not a constant — and validated before use.
  const proposed = await page.getByLabel('Fuseau horaire').inputValue();
  expect(proposed).not.toBe('');
  const usable = await page.evaluate((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, proposed);
  expect(usable, `le fuseau proposé « ${proposed} » doit être résoluble`).toBe(true);
  await expect(page.getByTestId('timezone-hint')).not.toContainText('Fuseau horaire inconnu');

  // An offset resolves in `Intl` but carries no DST rules, so it is refused
  // here exactly as the server refuses it.
  await page.getByLabel('Fuseau horaire').fill('+05:00');
  await expect(page.getByTestId('timezone-hint')).toContainText('Fuseau horaire inconnu');
  await expect(next(page)).toBeDisabled();

  await page.getByLabel('Fuseau horaire').fill('Europe/Lisbon');
  await expect(next(page)).toBeEnabled();
});

test('le fuseau horaire choisi à la création est celui qui est enregistré', async ({ page }) => {
  await openWizard(page);

  const name = eventName('RC2C Fuseau création');
  await page.getByLabel("Nom de l’événement *").fill(name);
  await page.getByLabel('Fuseau horaire').fill('Indian/Reunion');

  await next(page).click();
  await next(page).click();
  await next(page).click();
  await page.getByRole('button', { name: "Créer l’événement (brouillon)" }).click();
  await page.waitForURL('**/admin**');

  const events = await session.api.get('/api/v1/events').then((r) => r.json());
  const created = events.find((e: any) => e.name === name);
  const state = await getEventState(session, created.id);
  expect(state.event.timezone).toBe('Indian/Reunion');
});

test('les sens de passage de l’assistant se lisent « De X vers Y »', async ({ page }) => {
  await openWizard(page);

  await next(page).click();
  await page.getByLabel("Nom de l’espace intérieur").first().fill('Esplanade');
  await next(page).click();

  await expect(page.getByText('De Extérieur vers Esplanade', { exact: true })).toBeVisible();
  await expect(page.getByText('De Esplanade vers Extérieur', { exact: true })).toBeVisible();
  await expect(page.getByText('Espace A', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Espace B', { exact: true })).toHaveCount(0);
});

test('déplacer une extrémité réétiquette une suggestion mais jamais un libellé écrit à la main', async ({
  page,
}) => {
  await openWizard(page);

  await next(page).click();
  await page.getByLabel("Nom de l’espace intérieur").first().fill('Esplanade');
  await page.getByRole('button', { name: 'Ajouter un espace intérieur' }).click();
  await page.getByLabel("Nom de l’espace intérieur").nth(1).fill('Terrasse');
  await next(page).click();

  const entryLabel = page.getByLabel('Libellé du bouton : De Extérieur vers Esplanade');
  await expect(entryLabel).toHaveValue('ENTRÉE +1');

  // A suggestion follows the zones it was generated from…
  await page.getByLabel('Première zone de la porte').selectOption({ label: 'Terrasse' });
  await expect(page.getByLabel('Libellé du bouton : De Terrasse vers Esplanade')).toHaveValue(
    'VERS ESPLANADE'
  );

  // …and a label the operator wrote does not.
  const written = page.getByLabel('Libellé du bouton : De Terrasse vers Esplanade');
  await written.fill('MONTÉE CONTRÔLÉE');
  await page.getByLabel('Deuxième zone de la porte').selectOption({ label: 'Extérieur' });
  await expect(page.getByLabel('Libellé du bouton : De Terrasse vers Extérieur')).toHaveValue(
    'MONTÉE CONTRÔLÉE'
  );
});
