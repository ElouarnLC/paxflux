import { describe, expect, it } from 'vitest';
import {
  FALLBACK_TIMEZONE,
  TimezoneSchema,
  detectDefaultTimezone,
  isValidTimezone,
  supportedTimezones,
} from './timezone.js';

describe('isValidTimezone', () => {
  it('accepts real region/city identifiers', () => {
    for (const zone of ['Europe/Paris', 'America/New_York', 'Pacific/Auckland', 'UTC']) {
      expect(isValidTimezone(zone), zone).toBe(true);
    }
  });

  it('rejects fixed offsets and abbreviations, which carry no DST rules', () => {
    // `Intl.DateTimeFormat` accepts every one of these, which is exactly why
    // it cannot be the whole test: an event stored at `+05:00` would be an
    // hour wrong for half the year.
    for (const zone of ['+05:00', 'GMT', 'EST', 'Z']) {
      expect(isValidTimezone(zone), zone).toBe(false);
    }
  });

  it('rejects unknown zones the engine does not recognise', () => {
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimezone('Europe/Nowhere')).toBe(false);
  });

  it('rejects padding, so a stored value compares equal to the same zone typed cleanly', () => {
    expect(isValidTimezone(' Europe/Paris')).toBe(false);
    expect(isValidTimezone('Europe/Paris ')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });

  it('rejects anything that is not a string', () => {
    expect(isValidTimezone(undefined)).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
  });
});

describe('TimezoneSchema', () => {
  it('parses a valid zone unchanged, so it round-trips exactly', () => {
    expect(TimezoneSchema.parse('Europe/Paris')).toBe('Europe/Paris');
    expect(TimezoneSchema.parse('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
  });

  it('refuses an invalid identifier', () => {
    expect(TimezoneSchema.safeParse('Not/AZone').success).toBe(false);
    expect(TimezoneSchema.safeParse('+02:00').success).toBe(false);
  });
});

describe('detectDefaultTimezone', () => {
  it('takes the browser zone when it is usable', () => {
    expect(detectDefaultTimezone(() => 'Pacific/Auckland')).toBe('Pacific/Auckland');
  });

  it('falls back when the browser reports nothing', () => {
    expect(detectDefaultTimezone(() => undefined)).toBe(FALLBACK_TIMEZONE);
  });

  it('falls back when the browser reports something unusable', () => {
    expect(detectDefaultTimezone(() => 'GMT')).toBe(FALLBACK_TIMEZONE);
    expect(detectDefaultTimezone(() => 'Nonsense')).toBe(FALLBACK_TIMEZONE);
  });

  it('falls back when reading the zone throws', () => {
    expect(
      detectDefaultTimezone(() => {
        throw new Error('Intl unavailable');
      })
    ).toBe(FALLBACK_TIMEZONE);
  });

  it('uses the real environment by default without throwing', () => {
    expect(isValidTimezone(detectDefaultTimezone())).toBe(true);
  });
});

describe('supportedTimezones', () => {
  it('returns identifiers this engine accepts, or an empty list', () => {
    const zones = supportedTimezones();
    expect(Array.isArray(zones)).toBe(true);
    // Every offered zone must pass the validator, or the selector would let
    // an operator choose something the server refuses.
    for (const zone of zones.slice(0, 40)) {
      expect(isValidTimezone(zone), zone).toBe(true);
    }
  });
});
