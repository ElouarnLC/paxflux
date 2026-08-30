import { getAdminSession } from './helpers.js';

/**
 * Runs once before the whole Playwright run. Creates the single admin
 * account for the instance so individual specs can log in through the UI
 * with known credentials instead of racing on the one-time /setup flow.
 */
export default async function globalSetup() {
  await getAdminSession();
}
