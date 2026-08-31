import { SpaceModel } from '@paxflux/shared';

export interface CheckpointValidationError {
  code: string;
  message: string;
}

export function validateCheckpointRules(
  checkpoint: {
    spaceAId: string;
    spaceBId: string;
    allowAToB?: boolean;
    allowBToA?: boolean;
  },
  spacesMap: Map<string, Pick<SpaceModel, 'kind'>>
): CheckpointValidationError | null {
  const { spaceAId, spaceBId, allowAToB = true, allowBToA = true } = checkpoint;

  if (spaceAId === spaceBId) {
    return {
      code: 'SAME_SPACE_ENDPOINTS',
      message: 'Checkpoint endpoints spaceA and spaceB must be distinct spaces.',
    };
  }

  const spaceA = spacesMap.get(spaceAId);
  const spaceB = spacesMap.get(spaceBId);

  if (!spaceA) {
    return { code: 'SPACE_A_NOT_FOUND', message: `Space A (${spaceAId}) was not found.` };
  }
  if (!spaceB) {
    return { code: 'SPACE_B_NOT_FOUND', message: `Space B (${spaceBId}) was not found.` };
  }

  if (spaceA.kind === 'aggregate' || spaceB.kind === 'aggregate') {
    return {
      code: 'AGGREGATE_SPACE_ENDPOINT',
      message: 'Aggregate spaces cannot be used as checkpoint endpoints.',
    };
  }

  if (!allowAToB && !allowBToA) {
    return {
      code: 'NO_ACTIVE_DIRECTIONS',
      message: 'A checkpoint must have at least one active direction (A→B or B→A).',
    };
  }

  return null;
}
