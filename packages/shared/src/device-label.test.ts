import { describe, expect, it } from 'vitest';
import { DEVICE_LABEL_MAX_LENGTH, DeviceLabelSchema, RenameDeviceRequestSchema } from './device-label.js';

describe('DeviceLabelSchema', () => {
  it('trims before it decides, and stores what it validated', () => {
    const parsed = DeviceLabelSchema.parse('  Téléphone entrée nord  ');
    expect(parsed).toBe('Téléphone entrée nord');
  });

  it('refuses whitespace that only looks like a name', () => {
    // The old admin route checked `label.trim().length === 0` and then
    // stored `label.trim()` separately; a schema that trims first cannot
    // drift from what the caller writes.
    for (const blank of ['', '   ', '\t', '\n  \n']) {
      expect(DeviceLabelSchema.safeParse(blank).success, JSON.stringify(blank)).toBe(false);
    }
  });

  it('bounds the length after trimming, not before', () => {
    const atLimit = 'a'.repeat(DEVICE_LABEL_MAX_LENGTH);
    expect(DeviceLabelSchema.safeParse(atLimit).success).toBe(true);
    // Padding must not push a legal name over the edge.
    expect(DeviceLabelSchema.safeParse(`  ${atLimit}  `).success).toBe(true);
    expect(DeviceLabelSchema.safeParse('a'.repeat(DEVICE_LABEL_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('is wide enough for the label the server itself generates', () => {
    // `auth/pairing.ts` builds `${checkpoint.name} — appareil ${n}`, and a
    // checkpoint name is capped at 100. A bound that rejected that would
    // make a freshly paired device unable to save the name it was given —
    // which is why this is 120 and not, say, the 50 used for door labels.
    const generated = `${'P'.repeat(100)} — appareil 12`;
    expect(generated.length).toBeLessThanOrEqual(DEVICE_LABEL_MAX_LENGTH);
    expect(DeviceLabelSchema.safeParse(generated).success).toBe(true);
  });

  it('keeps a label as text, with no markup meaning', () => {
    // React renders it as text; nothing here interprets it. The schema's
    // job is length and emptiness, not sanitisation it cannot enforce.
    const value = '<b>Entrée</b> & "nord"';
    expect(DeviceLabelSchema.parse(value)).toBe(value);
  });
});

describe('RenameDeviceRequestSchema', () => {
  it('accepts a label and nothing else it could act on', () => {
    const parsed = RenameDeviceRequestSchema.parse({
      label: ' Entrée nord ',
      // Crafted fields a caller might hope reach a column. Zod strips
      // unknown keys by default, so what the route receives has one field.
      id: 'other-session',
      deviceSessionId: 'other-session',
      checkpointId: 'other-checkpoint',
      eventId: 'other-event',
      expiresAtMs: 1,
    } as Record<string, unknown>);

    expect(parsed).toEqual({ label: 'Entrée nord' });
    expect(Object.keys(parsed)).toEqual(['label']);
  });

  it('refuses a body with no usable label', () => {
    expect(RenameDeviceRequestSchema.safeParse({}).success).toBe(false);
    expect(RenameDeviceRequestSchema.safeParse({ label: '  ' }).success).toBe(false);
  });
});
