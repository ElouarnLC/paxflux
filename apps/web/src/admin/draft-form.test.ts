import { describe, expect, it } from 'vitest';
import { CheckpointModel, SpaceModel } from '@paxflux/shared';
import {
  applyEventCapacity,
  defaultDirectionLabel,
  describeDirection,
  describePreflightError,
  describeSpace,
  editedLabel,
  generatedLabel,
  hasEditableCapacity,
  hasUsableDirections,
  independentCapacity,
  linkedCapacity,
  overrideCapacity,
  relabelForEndpoints,
  relinkCapacity,
  toEditableCheckpoints,
  toEditableSpaces,
} from './draft-form.js';

const EXTERIOR = { name: 'Extérieur', kind: 'external' as const };
const SITE = { name: 'Site', kind: 'leaf' as const };
const VIP = { name: 'VIP', kind: 'leaf' as const };

function space(overrides: Partial<SpaceModel> = {}): SpaceModel {
  return {
    id: 'space-1',
    eventId: 'event-1',
    parentId: null,
    name: 'Site',
    kind: 'leaf',
    capacity: 2000,
    sortOrder: 1,
    isActive: true,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

function checkpoint(overrides: Partial<CheckpointModel> = {}): CheckpointModel {
  return {
    id: 'cp-1',
    eventId: 'event-1',
    name: 'Porte principale',
    spaceAId: 'ext',
    spaceBId: 'site',
    allowAToB: true,
    allowBToA: true,
    labelAToB: 'ENTRÉE +1',
    labelBToA: 'SORTIE −1',
    sortOrder: 0,
    isActive: true,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

describe('capacity linking — creation', () => {
  it('follows the event capacity while the zone has not been touched', () => {
    // The field defect: both started at 1500 as independent state, so raising
    // the event to 2200 left the zone at 1500 and the draft internally
    // inconsistent.
    let site = linkedCapacity(1500);
    expect(site.capacity).toBe(1500);

    site = applyEventCapacity(site, 2200);
    expect(site.capacity).toBe(2200);
    expect(site.link).toBe('linked');
  });

  it('stops following once the operator sets the zone explicitly', () => {
    let site = linkedCapacity(1500);
    site = applyEventCapacity(site, 2200);
    site = overrideCapacity(site, 1200);
    expect(site.capacity).toBe(1200);

    site = applyEventCapacity(site, 2500);
    expect(site.capacity, 'an explicit choice is never silently overwritten').toBe(1200);
    expect(site.link).toBe('independent');
  });

  it('treats typing the event’s own number as an explicit choice too', () => {
    // Equal values must not be read as "still linked": the operator has said
    // this zone owns its capacity, and the next event change must respect it.
    let site = linkedCapacity(1500);
    site = overrideCapacity(site, 1500);
    site = applyEventCapacity(site, 3000);

    expect(site.capacity).toBe(1500);
  });

  it('re-links only when the operator asks for it', () => {
    let site = overrideCapacity(linkedCapacity(1500), 1200);
    site = relinkCapacity(2500);
    expect(site).toEqual({ link: 'linked', capacity: 2500 });

    site = applyEventCapacity(site, 2600);
    expect(site.capacity).toBe(2600);
  });

  it('leaves additional zones independent from the start', () => {
    let vip = independentCapacity(100);
    vip = applyEventCapacity(vip, 9000);
    expect(vip.capacity).toBe(100);
  });

  it('carries an emptied field without inventing a number', () => {
    const site = overrideCapacity(linkedCapacity(1500), '');
    expect(site.capacity).toBe('');
  });
});

describe('capacity linking — editing a stored draft', () => {
  it('never infers a link from a matching capacity or a familiar name', () => {
    // The stored draft has event 2000 / Site 2000. Nothing records a
    // relationship between them, so raising the event must not move the zone.
    const [site] = toEditableSpaces([space({ name: 'Site', capacity: 2000 })]);
    expect(site.capacity).toEqual({ link: 'independent', capacity: 2000 });

    const afterEventChange = applyEventCapacity(site.capacity, 2500);
    expect(afterEventChange.capacity, 'the stored zone capacity stands').toBe(2000);
  });

  it('loads a zone with no capacity as an empty field', () => {
    const [zone] = toEditableSpaces([space({ capacity: null })]);
    expect(zone.capacity.capacity).toBe('');
  });

  it('keeps the sentinel and every zone, with their kinds', () => {
    const loaded = toEditableSpaces([
      space({ id: 'ext', name: 'Extérieur', kind: 'external', capacity: null }),
      space({ id: 'site', name: 'Site', kind: 'leaf', capacity: 2000 }),
    ]);
    expect(loaded.map((s) => s.kind)).toEqual(['external', 'leaf']);
  });
});

describe('direction labels and their provenance', () => {
  it('generates entrée/sortie only where the outside is involved', () => {
    expect(defaultDirectionLabel(EXTERIOR, SITE)).toBe('ENTRÉE +1');
    expect(defaultDirectionLabel(SITE, EXTERIOR)).toBe('SORTIE −1');
  });

  it('describes an internal transfer as a movement, not as an entry', () => {
    // Walking from Site to VIP is not an "entrée" in any global sense.
    expect(defaultDirectionLabel(SITE, VIP)).toBe('VERS VIP');
    expect(defaultDirectionLabel(VIP, SITE)).toBe('VERS SITE');
  });

  it('follows the endpoints while the label is still generated', () => {
    const label = generatedLabel(SITE, VIP);
    expect(relabelForEndpoints(label, SITE, EXTERIOR).value).toBe('SORTIE −1');
  });

  it('never rewrites a label the operator wrote', () => {
    const label = editedLabel('PORTE VIP');
    const after = relabelForEndpoints(label, EXTERIOR, SITE);
    expect(after.value).toBe('PORTE VIP');
    expect(after.provenance).toBe('edited');
  });

  it('treats a label edited back to its generated text as edited', () => {
    // Provenance is recorded when the value is set, not inferred from the
    // text afterwards — otherwise this would silently become overwritable.
    const label = editedLabel('ENTRÉE +1');
    expect(relabelForEndpoints(label, SITE, VIP).value).toBe('ENTRÉE +1');
  });

  it('loads stored labels as edited, never as suggestions', () => {
    const [loaded] = toEditableCheckpoints([checkpoint({ labelAToB: 'GRANDE PORTE' })]);
    expect(loaded.labelAToB).toEqual({ provenance: 'edited', value: 'GRANDE PORTE' });
    expect(relabelForEndpoints(loaded.labelAToB, SITE, VIP).value).toBe('GRANDE PORTE');
  });
});

describe('operator-facing wording', () => {
  it('describes a direction as a movement between named zones', () => {
    expect(describeDirection(EXTERIOR, SITE)).toBe('De Extérieur vers Site');
    expect(describeDirection(SITE, VIP)).toBe('De Site vers VIP');
  });

  it('never exposes A/B vocabulary', () => {
    const wording = [
      describeDirection(EXTERIOR, SITE),
      describeDirection(SITE, EXTERIOR),
      describeSpace(SITE),
      describeSpace(EXTERIOR),
    ].join(' ');
    expect(wording).not.toMatch(/\bA\s*→|\bB\s*→|space ?A|space ?B|zone A\b|zone B\b/i);
  });

  it('names the sentinel as a boundary rather than a zone', () => {
    expect(describeSpace(EXTERIOR)).toBe('Extérieur — frontière de comptage');
    expect(describeSpace(SITE)).toBe('Site');
  });

  it('offers no capacity for the sentinel', () => {
    expect(hasEditableCapacity(EXTERIOR)).toBe(false);
    expect(hasEditableCapacity(SITE)).toBe(true);
  });
});

describe('direction validity', () => {
  it('requires at least one direction', () => {
    expect(hasUsableDirections({ allowAToB: true, allowBToA: false })).toBe(true);
    expect(hasUsableDirections({ allowAToB: false, allowBToA: true })).toBe(true);
    expect(hasUsableDirections({ allowAToB: false, allowBToA: false })).toBe(false);
  });
});

describe('describePreflightError', () => {
  it('says, in the operator’s language, what is missing', () => {
    expect(
      describePreflightError({
        code: 'NO_ACTIVE_CHECKPOINTS',
        message: 'The event must have at least one active checkpoint.',
      })
    ).toBe('Ajoutez au moins une porte : sans passage, aucun comptage n’est possible.');

    expect(
      describePreflightError({
        code: 'NO_INTERNAL_LEAF_SPACES',
        message: 'The event must have at least one active internal leaf space.',
      })
    ).toContain('zone interne');

    expect(
      describePreflightError({
        code: 'NO_ACTIVE_EXTERNAL_SPACE',
        message: 'The event must have at least one active external (boundary) space.',
      })
    ).toContain('frontière de comptage');
  });

  it('keeps the door’s name, which is what locates the problem', () => {
    // The server phrases per-checkpoint refusals as `Checkpoint "<name>": …`.
    // Losing the name would leave an operator with four doors and no clue.
    expect(
      describePreflightError({
        code: 'INVALID_CHECKPOINT_NO_ACTIVE_DIRECTIONS',
        message: 'Checkpoint "Porte Nord": A checkpoint must have at least one active direction (A→B or B→A).',
      })
    ).toBe('La porte « Porte Nord » n’autorise aucun sens de passage.');

    expect(
      describePreflightError({
        code: 'INVALID_CHECKPOINT_SAME_SPACE_ENDPOINTS',
        message: 'Checkpoint "Passage VIP": Checkpoint endpoints spaceA and spaceB must be distinct spaces.',
      })
    ).toContain('« Passage VIP »');
  });

  it('falls back to the server’s own sentence rather than inventing a vague one', () => {
    // A wrong-language sentence that names the problem is worth more than a
    // French one that does not. This is also what keeps a new server-side
    // rule visible here instead of silently reading "erreur inconnue".
    expect(
      describePreflightError({ code: 'SOME_FUTURE_RULE', message: 'Something specific went wrong.' })
    ).toBe('Something specific went wrong.');

    expect(
      describePreflightError({
        code: 'INVALID_CHECKPOINT_FUTURE_RULE',
        message: 'Checkpoint "Porte Est": something specific.',
      })
    ).toContain('« Porte Est »');
  });

  it('has nothing to say when the server raised no objection', () => {
    expect(describePreflightError(null)).toBe('');
  });
});
