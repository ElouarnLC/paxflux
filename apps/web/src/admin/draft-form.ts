import { CheckpointModel, SpaceModel } from '@paxflux/shared';

/**
 * The form rules behind the wizard and the draft editor.
 *
 * All pure, because every one of them is a decision that has been got wrong
 * by guessing: whether a space's capacity should follow the event's, whether
 * a direction label was written by the operator or generated for them, and
 * how a door reads to someone who has never heard of "space A".
 */

// ---------------------------------------------------------------------------
// Capacity linking
// ---------------------------------------------------------------------------

/**
 * Whether a space's capacity is still following the event's.
 *
 * This is *form state*, never an inference. Two capacities that happen to be
 * equal, or a space that happens to be called "Site", say nothing about what
 * the operator intended — and a draft loaded from the server carries two
 * independently persisted numbers with no relationship recorded between
 * them. So a space loaded for editing is always `'independent'` unless the
 * operator asks otherwise, and only the wizard's own first zone starts
 * `'linked'`, because there the operator has not yet said anything at all.
 */
export type CapacityLink = 'linked' | 'independent';

export interface CapacityFieldState {
  link: CapacityLink;
  capacity: number | '';
}

/** The first zone a new event gets, tracking the capacity just typed for it. */
export function linkedCapacity(eventCapacity: number): CapacityFieldState {
  return { link: 'linked', capacity: eventCapacity };
}

/** Every other zone: whatever it was given, answering to nobody. */
export function independentCapacity(capacity: number | ''): CapacityFieldState {
  return { link: 'independent', capacity };
}

/**
 * The event capacity changed. Linked zones follow; overridden ones do not.
 */
export function applyEventCapacity(field: CapacityFieldState, eventCapacity: number): CapacityFieldState {
  return field.link === 'linked' ? { link: 'linked', capacity: eventCapacity } : field;
}

/**
 * The operator typed in the zone's own capacity, which ends the link.
 *
 * Ending it on the edit rather than on a difference in value matters: typing
 * the same number the event already has is still an explicit statement that
 * this zone owns its capacity from now on.
 */
export function overrideCapacity(_field: CapacityFieldState, capacity: number | ''): CapacityFieldState {
  return { link: 'independent', capacity };
}

/** The operator asked for the link back, explicitly. */
export function relinkCapacity(eventCapacity: number): CapacityFieldState {
  return { link: 'linked', capacity: eventCapacity };
}

// ---------------------------------------------------------------------------
// Direction labels
// ---------------------------------------------------------------------------

/**
 * Where a direction's button label came from.
 *
 * A label generated from the zones a door connects should follow those zones
 * when they change — that is the useful part. A label the operator wrote must
 * never be silently rewritten. Telling them apart by inspecting the text
 * afterwards is guesswork, so provenance is recorded when the value is set.
 */
export type LabelProvenance = 'generated' | 'edited';

export interface LabelFieldState {
  provenance: LabelProvenance;
  value: string;
}

/**
 * The default label for a crossing.
 *
 * A door onto the outside is the one case where "entrée"/"sortie" is
 * unambiguous. Between two internal zones it is not — walking from Site to
 * VIP is not an "entrée" in any global sense — so those read as the movement
 * they are.
 */
export function defaultDirectionLabel(from: SpaceLike, to: SpaceLike): string {
  if (from.kind === 'external') return 'ENTRÉE +1';
  if (to.kind === 'external') return 'SORTIE −1';
  return `VERS ${to.name.toUpperCase()}`;
}

export function generatedLabel(from: SpaceLike, to: SpaceLike): LabelFieldState {
  return { provenance: 'generated', value: defaultDirectionLabel(from, to) };
}

export function editedLabel(value: string): LabelFieldState {
  return { provenance: 'edited', value };
}

/**
 * The door's endpoints moved. A generated label follows; an edited one stays.
 */
export function relabelForEndpoints(
  field: LabelFieldState,
  from: SpaceLike,
  to: SpaceLike
): LabelFieldState {
  return field.provenance === 'generated' ? generatedLabel(from, to) : field;
}

// ---------------------------------------------------------------------------
// Direction wording
// ---------------------------------------------------------------------------

export interface SpaceLike {
  name: string;
  kind: SpaceModel['kind'];
}

/**
 * How a direction is described to an operator: as the movement it is.
 *
 * "A→B" is the wire's vocabulary and the ledger's; it is not the field's.
 * Someone standing at a door thinks "from the outside into the site", so
 * that is what the form says.
 */
export function describeDirection(from: SpaceLike, to: SpaceLike): string {
  return `De ${from.name} vers ${to.name}`;
}

/** The sentinel, named for what it is rather than shown as a zone. */
export const EXTERNAL_SPACE_HINT = 'frontière de comptage';

export function describeSpace(space: SpaceLike): string {
  return space.kind === 'external' ? `${space.name} — ${EXTERNAL_SPACE_HINT}` : space.name;
}

/** Only real zones hold people; the sentinel never shows a capacity. */
export function hasEditableCapacity(space: SpaceLike): boolean {
  return space.kind === 'leaf';
}

// ---------------------------------------------------------------------------
// Loading a stored draft
// ---------------------------------------------------------------------------

export interface EditableSpace {
  id: string;
  name: string;
  kind: SpaceModel['kind'];
  capacity: CapacityFieldState;
}

/**
 * A stored draft's spaces, as the editor holds them.
 *
 * Every capacity comes back `'independent'`: the server records two numbers
 * and no relationship between them, and inventing one from a matching value
 * or a familiar name would silently overwrite an operator's earlier decision
 * the next time the event capacity moved.
 */
export function toEditableSpaces(spaces: SpaceModel[]): EditableSpace[] {
  return spaces.map((space) => ({
    id: space.id,
    name: space.name,
    kind: space.kind,
    capacity: independentCapacity(space.capacity ?? ''),
  }));
}

export interface EditableCheckpoint {
  id: string;
  name: string;
  spaceAId: string;
  spaceBId: string;
  allowAToB: boolean;
  allowBToA: boolean;
  labelAToB: LabelFieldState;
  labelBToA: LabelFieldState;
}

/**
 * A stored draft's doors, as the editor holds them.
 *
 * Labels load as `'edited'`: they are already persisted values, and the
 * editor must not treat them as suggestions it may overwrite.
 */
export function toEditableCheckpoints(checkpoints: CheckpointModel[]): EditableCheckpoint[] {
  return checkpoints.map((checkpoint) => ({
    id: checkpoint.id,
    name: checkpoint.name,
    spaceAId: checkpoint.spaceAId,
    spaceBId: checkpoint.spaceBId,
    allowAToB: checkpoint.allowAToB,
    allowBToA: checkpoint.allowBToA,
    labelAToB: editedLabel(checkpoint.labelAToB),
    labelBToA: editedLabel(checkpoint.labelBToA),
  }));
}

/** A door needs somewhere to lead; both directions off is not a door. */
export function hasUsableDirections(checkpoint: Pick<EditableCheckpoint, 'allowAToB' | 'allowBToA'>): boolean {
  return checkpoint.allowAToB || checkpoint.allowBToA;
}
