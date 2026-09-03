/**
 * What the counter's big number actually means.
 *
 * PaxFlux counts optimistically on purpose: a tap moves the gauge before the
 * server has heard about it, because a field operator at a door cannot wait
 * for a round trip. That is not the problem this module addresses and it is
 * not changed here.
 *
 * The problem is that the projected number was presented as *the* number.
 * An operator reading `104 / 1500` could not tell whether the server holds
 * 104 or holds 101 with three taps still queued on this handset — and those
 * are very different facts when a supervisor asks how many people are in.
 *
 * So the display carries three values rather than one:
 *
 *   authoritative  what the server last told us
 *   pendingDelta   what this device has counted and not yet had acknowledged
 *   displayed      authoritative + pendingDelta, which is what the gauge shows
 *
 * Pure, because every interesting case is an arithmetic one — a negative
 * server truth, a locally-projected negative, an acknowledgement arriving —
 * and none of them should need a browser to argue about.
 */

/** The two ways an occupancy can be incoherent. Neither is ever corrected. */
export type OccupancyAnomalyKind = 'negative' | 'over-capacity';

/**
 * Whose number is incoherent.
 *
 * The distinction is the whole point of reporting it: `authoritative` means
 * the server has already recorded this and it is a real operational problem;
 * `projected` means only this device's unacknowledged arithmetic gets there,
 * and saying the server accepted it would be a lie.
 */
export type OccupancyAnomalyScope = 'authoritative' | 'projected';

export interface OccupancyAnomaly {
  kind: OccupancyAnomalyKind;
  scope: OccupancyAnomalyScope;
  /** The value that is incoherent — the server's, or the projected one. */
  value: number;
}

export interface OccupancyTruth {
  authoritative: number;
  pendingDelta: number;
  displayed: number;
  capacity: number;
  /**
   * Whether to explain the gauge as a sum.
   *
   * False when the delta is zero, which is not the same as "no pending
   * actions": an internal transfer moves a person from one zone to another
   * and leaves the global gauge alone. Announcing `+0 en attente` there would
   * be noise, and worse, it would imply the transfer is not pending at all.
   * The sync badge is what shows those; see `CounterView`.
   */
  disclosePending: boolean;
  anomaly: OccupancyAnomaly | null;
}

function classify(value: number, capacity: number): OccupancyAnomalyKind | null {
  if (value < 0) return 'negative';
  // A capacity of 0 means "not configured", not "everyone is over capacity".
  if (capacity > 0 && value > capacity) return 'over-capacity';
  return null;
}

/**
 * Reads the three values and decides what, if anything, is wrong.
 *
 * The anomaly rule has one subtlety worth stating: an anomaly the *server*
 * already holds is reported even when the local projection happens to cancel
 * it out. A device that has counted one entry against a server occupancy of
 * −1 shows a displayed 0, and reporting nothing there would let a real,
 * already-recorded incoherence disappear behind this handset's own pending
 * arithmetic. Authoritative therefore wins whenever both are anomalous.
 */
export function readOccupancyTruth(input: {
  authoritative: number;
  pendingDelta: number;
  capacity: number;
}): OccupancyTruth {
  const { authoritative, pendingDelta, capacity } = input;
  const displayed = authoritative + pendingDelta;

  const authoritativeKind = classify(authoritative, capacity);
  const displayedKind = classify(displayed, capacity);

  const anomaly: OccupancyAnomaly | null = authoritativeKind
    ? { kind: authoritativeKind, scope: 'authoritative', value: authoritative }
    : displayedKind
      ? { kind: displayedKind, scope: 'projected', value: displayed }
      : null;

  return {
    authoritative,
    pendingDelta,
    displayed,
    capacity,
    disclosePending: pendingDelta !== 0,
    anomaly,
  };
}

/**
 * A count, written the way the counter's own buttons are.
 *
 * The minus is U+2212, matching `SORTIE −1` on the count button rather than
 * a hyphen: at arm's length in the dark the two are not equally legible.
 * `toLocaleString('fr-FR')` is deliberately not asked for the sign — CLDR
 * gives French the ASCII hyphen-minus, so formatting a negative through it
 * alone produces a different glyph from the one beside it on screen.
 */
export function formatCount(value: number): string {
  const magnitude = Math.abs(value).toLocaleString('fr-FR');
  return value < 0 ? `−${magnitude}` : magnitude;
}

/** The same, with the sign always shown, for a delta. */
export function formatSignedDelta(delta: number): string {
  return delta < 0 ? formatCount(delta) : `+${formatCount(delta)}`;
}

/**
 * `Serveur : 101` — what the server last confirmed, named as such.
 *
 * Formatted through `formatCount` because the server's own occupancy can be
 * negative (ADR-004 records it rather than clamping it), and that case is
 * precisely the one an operator will be reading aloud to a supervisor.
 */
export function describeAuthoritative(truth: OccupancyTruth): string {
  return `Serveur : ${formatCount(truth.authoritative)}`;
}

/**
 * `+3 en attente sur cet appareil`.
 *
 * Scoped to *this* handset on purpose. The delta is computed from this
 * device's own outbox, so it says nothing about what other phones on other
 * doors are holding, and implying otherwise would mislead a supervisor
 * reading over the operator's shoulder.
 */
export function describePendingDelta(truth: OccupancyTruth): string {
  return `${formatSignedDelta(truth.pendingDelta)} en attente sur cet appareil`;
}

/**
 * The anomaly, said compactly enough for a phone held at a door.
 *
 * Never suggests an action the person holding this device cannot take: a
 * counter operator cannot make a supervised adjustment, so they are asked to
 * report it rather than to fix it. `ADR-004` is what the second sentence is
 * about — the movements stand as counted, and nothing is quietly corrected.
 */
export function describeAnomalyForCounter(anomaly: OccupancyAnomaly, capacity: number): string {
  const value = formatCount(anomaly.value);

  if (anomaly.scope === 'projected') {
    return anomaly.kind === 'negative'
      ? `Occupation projetée négative (${value}). Comptages conservés, en attente de confirmation du serveur.`
      : `Capacité projetée dépassée (${value} / ${formatCount(capacity)}). Comptages conservés, en attente de confirmation du serveur.`;
  }

  return anomaly.kind === 'negative'
    ? `Occupation négative (${value}). PaxFlux conserve les comptages tels quels : signalez-le à la supervision.`
    : `Capacité dépassée (${value} / ${formatCount(capacity)}). PaxFlux conserve les comptages tels quels : signalez-le à la supervision.`;
}

/**
 * The same fact for a supervisor, who can actually act on it.
 *
 * Points at the supervised adjustment that already exists rather than
 * inventing a workflow, and still says plainly that nothing was corrected
 * automatically.
 */
export function describeAnomalyForSupervisor(anomaly: OccupancyAnomaly, capacity: number): string {
  const value = formatCount(anomaly.value);

  return anomaly.kind === 'negative'
    ? `Occupation négative (${value}). Le journal est conservé tel quel : vérifiez les passages, puis corrigez par un ajustement supervisé si nécessaire.`
    : `Capacité dépassée (${value} / ${formatCount(capacity)}). Le journal est conservé tel quel : vérifiez les passages, puis corrigez par un ajustement supervisé si nécessaire.`;
}
