/**
 * Offline database restore — the single supported way to restore PaxFlux.
 *
 * Run from a one-shot container, with the service stopped:
 *
 *   docker compose stop paxflux
 *   docker compose run --rm --no-deps paxflux npm run db:restore -- /backups/<file>.db
 *   docker compose start paxflux
 *
 * It runs as the image's runtime user, so the database it puts in place belongs
 * to that user by construction — the ownership trap of a root-side file copy
 * cannot happen.
 *
 * It exits non-zero on any problem, and distinguishes the two cases that matter
 * to whoever is standing in front of the machine: a failure *before* the
 * snapshot was promoted leaves the existing database exactly as it was, and the
 * service can simply be started again; a failure *after* promotion means the
 * snapshot is already the database, and the service must stay stopped. The
 * command never reports the second as the first.
 */
import path from 'node:path';
import { parseEnv } from '../config/env.js';
import { restoreDatabaseFromFile, RestoreError } from '../backups/backup-service.js';

const USAGE = `Usage: npm run db:restore -- <backup-file> [--target <path-to-app.db>]

  <backup-file>      Snapshot to restore, e.g. /backups/paxflux-backup-<ts>-<reason>.db
  --target <path>    Database to replace. Defaults to <DATA_DIR>/app.db.

Stop the PaxFlux service before running this. Restoring under a running
server would replace the file it has open.`;

interface ParsedArgs {
  backupFile: string;
  target?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let target: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') {
      target = argv[i + 1];
      if (!target) throw new Error('--target requires a path.');
      i += 1;
    } else if (arg === '-h' || arg === '--help') {
      throw new Error(USAGE);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) throw new Error(`No backup file given.\n\n${USAGE}`);
  if (positional.length > 1) {
    throw new Error(`Expected one backup file, got ${positional.length}.\n\n${USAGE}`);
  }

  return { backupFile: positional[0], target };
}

function main(): void {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
    return;
  }

  const env = parseEnv();
  const target = args.target ?? path.resolve(env.DATA_DIR, 'app.db');

  console.log('PaxFlux — offline database restore');
  console.log(`  snapshot : ${path.resolve(args.backupFile)}`);
  console.log(`  target   : ${path.resolve(target)}`);
  console.log('');

  try {
    const result = restoreDatabaseFromFile(args.backupFile, target);
    console.log('  ok  snapshot passed PRAGMA quick_check before anything was replaced');
    console.log(`  ok  sha256 ${result.sha256}`);
    console.log(
      `  ok  revoked ${result.revokedStaffSessions} staff session(s) and ` +
        `${result.revokedDeviceSessions} device session(s) carried by the snapshot`
    );
    console.log(
      result.removedSidecars.length > 0
        ? `  ok  removed stale sidecars: ${result.removedSidecars.join(', ')}`
        : '  ok  no stale sidecars to remove'
    );
    console.log('  ok  restored database passed PRAGMA quick_check');
    console.log(`  ok  ${result.sizeBytes} bytes in place at ${result.targetDbPath}`);
    console.log('');
    console.log('Restore complete. Start the service again:');
    console.log('  docker compose start paxflux');
    process.exit(0);
  } catch (err) {
    const promoted = err instanceof RestoreError && err.promoted;
    if (err instanceof RestoreError) {
      console.error(`RESTORE FAILED (${err.step}): ${err.message}`);
    } else {
      console.error(`RESTORE FAILED: ${(err as Error).message}`);
    }
    console.error('');

    if (promoted) {
      // The rename already happened: the snapshot IS the database now.
      // Saying "nothing was touched" here would send an operator to restart a
      // service on a database nobody has verified.
      console.error('THE SNAPSHOT HAS ALREADY BEEN PROMOTED and could not be verified.');
      console.error(`The database at ${path.resolve(target)} is the restored snapshot,`);
      console.error('not the one that was there before.');
      console.error('');
      console.error('Leave the service STOPPED. Do not start it until this is resolved.');
      console.error('Investigate the database in place, or restore another snapshot');
      console.error('with this same command before starting again.');
    } else {
      console.error('The existing database was left untouched: nothing was promoted,');
      console.error('and the service can be started again as it was.');
    }
    process.exit(1);
  }
}

// Only run when executed directly, so the argument parser stays unit-testable.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) {
  main();
}
