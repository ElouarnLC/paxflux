import { SpaceKind } from '@paxflux/shared';

export interface SpaceValidationError {
  code: string;
  message: string;
}

export function detectParentCycle(
  allSpaces: Array<{ id: string; parentId: string | null }>,
  spaceId: string,
  proposedParentId: string | null
): boolean {
  if (!proposedParentId) return false;
  if (spaceId === proposedParentId) return true;

  const parentMap = new Map<string, string | null>();
  for (const s of allSpaces) {
    parentMap.set(s.id, s.parentId);
  }
  parentMap.set(spaceId, proposedParentId);

  const visited = new Set<string>();
  let current: string | null = proposedParentId;

  while (current) {
    if (visited.has(current)) return true;
    if (current === spaceId) return true;
    visited.add(current);
    current = parentMap.get(current) || null;
  }

  return false;
}

export function validateSpaceRules(
  space: { kind: SpaceKind; parentId?: string | null; capacity?: number | null },
  existingSpaces: Array<{ id: string; parentId: string | null; kind: string }>,
  spaceId?: string
): SpaceValidationError | null {
  // External spaces cannot have parent or capacity
  if (space.kind === 'external') {
    if (space.parentId) {
      return { code: 'EXTERNAL_CANNOT_HAVE_PARENT', message: 'An external space cannot have a parent space.' };
    }
  }

  // A parent must exist among this event's own spaces — `existingSpaces` is
  // always scoped to one event by its caller, so this also rejects a
  // parentId that belongs to a different event, not just an unknown UUID.
  if (space.parentId) {
    const parent = existingSpaces.find((s) => s.id === space.parentId);
    if (!parent) {
      return { code: 'PARENT_NOT_FOUND', message: `Parent space (${space.parentId}) was not found in this event.` };
    }
    // Aggregate spaces cannot be children of leaf spaces
    if (parent.kind === 'leaf') {
      return { code: 'INVALID_PARENT_KIND', message: 'A leaf space cannot be a parent of another space.' };
    }
  }

  // Cycle check
  if (spaceId && space.parentId) {
    if (detectParentCycle(existingSpaces, spaceId, space.parentId)) {
      return { code: 'PARENT_CYCLE_DETECTED', message: 'A cycle was detected in the space hierarchy.' };
    }
  }

  return null;
}

export function calculateAggregateOccupancy(
  allSpaces: Array<{ id: string; parentId: string | null; kind: string }>,
  leafOccupancies: Map<string, number>
): Map<string, number> {
  const result = new Map<string, number>();

  // Initialize all with 0
  for (const s of allSpaces) {
    if (s.kind === 'leaf') {
      result.set(s.id, leafOccupancies.get(s.id) || 0);
    } else {
      result.set(s.id, 0);
    }
  }

  // Helper to get all descendant leaf space IDs of an aggregate space
  function getDescendantLeafIds(aggregateId: string): string[] {
    const leaves: string[] = [];
    const directChildren = allSpaces.filter((s) => s.parentId === aggregateId);
    for (const child of directChildren) {
      if (child.kind === 'leaf') {
        leaves.push(child.id);
      } else if (child.kind === 'aggregate') {
        leaves.push(...getDescendantLeafIds(child.id));
      }
    }
    return leaves;
  }

  for (const s of allSpaces) {
    if (s.kind === 'aggregate') {
      const leaves = getDescendantLeafIds(s.id);
      const total = leaves.reduce((sum, leafId) => sum + (leafOccupancies.get(leafId) || 0), 0);
      result.set(s.id, total);
    }
  }

  return result;
}
