import { ConfirmedActionRecord, OutboxActionOwner, OutboxActionRecord } from '@paxflux/shared';
import { localDb } from './db.js';
import { sameOwner } from './outbox-state.js';

/**
 * A short, bounded memory of counts the server has confirmed.
 *
 * The acknowledgment lifecycle requires an `applied`/`duplicate` action to
 * leave the outbox — that is what stops a lost response from becoming a
 * double count. But SPEC §11.2 expects the operator to still be able to undo
 * the last count they made, and a count that synced quickly would otherwise
 * become un-undoable the moment the network was good.
 *
 * This keeps exactly what a reversal needs: the target's id, its direction,
 * the identity that made it, and the checkpoint endpoints as they stood so
 * the reversal can be projected locally. Nothing that would make it a second
 * ledger.
 */

/** How many confirmed counts to remember. Undo is a "last few taps" affordance. */
const MAX_CONFIRMED_ACTIONS = 20;
/** Beyond this, a count is no longer something the operator is undoing "now". */
const CONFIRMED_RETENTION_MS = 60 * 60 * 1000;

/**
 * Remembers a count the server confirmed, at the moment it leaves the outbox.
 *
 * Reversals are not remembered: undoing an undo is not an affordance the
 * counter offers, and a reversal is never itself a reversal target.
 */
export async function recordConfirmedAction(
  action: OutboxActionRecord,
  endpoints: { spaceAId: string; spaceBId: string }
): Promise<void> {
  if (action.type !== 'count' || !action.owner) return;

  await localDb.confirmed_actions.put({
    clientActionId: action.clientActionId,
    type: 'count',
    direction: action.direction,
    owner: action.owner,
    spaceAId: endpoints.spaceAId,
    spaceBId: endpoints.spaceBId,
    clientCreatedAtMs: action.clientCreatedAtMs,
    confirmedAtMs: Date.now(),
  });

  await pruneConfirmedActions();
}

async function pruneConfirmedActions(): Promise<void> {
  const cutoff = Date.now() - CONFIRMED_RETENTION_MS;
  const all = await localDb.confirmed_actions.orderBy('confirmedAtMs').reverse().toArray();

  const doomed = all.filter((record, index) => index >= MAX_CONFIRMED_ACTIONS || record.confirmedAtMs < cutoff);
  if (doomed.length === 0) return;
  await localDb.confirmed_actions.bulkDelete(doomed.map((record) => record.clientActionId));
}

/** Confirmed counts made by this identity, newest first. */
export async function getConfirmedActions(owner: OutboxActionOwner | null): Promise<ConfirmedActionRecord[]> {
  if (!owner) return [];
  const all = await localDb.confirmed_actions.orderBy('confirmedAtMs').reverse().toArray();
  return all.filter((record) => sameOwner(record.owner, owner));
}

export async function getConfirmedAction(clientActionId: string): Promise<ConfirmedActionRecord | undefined> {
  return localDb.confirmed_actions.get(clientActionId);
}

// Marking a confirmed count as reversed is deliberately *not* exposed here:
// it may only happen inside the same Dexie transaction that queues the
// reversal (see `enqueueReversalAction`). Stamping it separately would open
// a window where the count is neither undone nor undoable.

/**
 * Drops everything this identity did not produce.
 *
 * Called on re-pairing: a previous session's confirmed counts are not this
 * device's to undo, and offering them would build a reversal under the wrong
 * identity.
 */
export async function forgetConfirmedActionsOfOtherOwners(owner: OutboxActionOwner): Promise<number> {
  const all = await localDb.confirmed_actions.toArray();
  const foreign = all.filter((record) => !sameOwner(record.owner, owner));
  if (foreign.length === 0) return 0;
  await localDb.confirmed_actions.bulkDelete(foreign.map((record) => record.clientActionId));
  return foreign.length;
}
