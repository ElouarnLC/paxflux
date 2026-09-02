import { z } from 'zod';

/**
 * Timezone identity, shared by the client that offers a choice and the
 * server that stores it.
 *
 * An event's timezone decides how its day is drawn in exports and reports,
 * so it has to be a zone with rules — one that knows about daylight saving —
 * rather than a fixed offset that silently goes an hour wrong twice a year.
 *
 * `Intl.DateTimeFormat` alone is not that test. It happily accepts `+05:00`,
 * `GMT` and `EST`, none of which carry DST rules, so the check below is
 * shape-then-engine: a region/city identifier (or plain `UTC`), confirmed by
 * the engine. What it is *not* is a hardcoded list — that would go stale
 * with every tzdata release.
 */

/** `Europe/Paris`, `America/Argentina/Buenos_Aires`, `Etc/GMT+5`. */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Surrounding whitespace would round-trip into storage and compare unequal
  // to the same zone entered cleanly.
  if (value !== value.trim() || value.length === 0) return false;
  if (value !== 'UTC' && !IANA_SHAPE.test(value)) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    // RangeError: the engine does not know this zone.
    return false;
  }
}

/**
 * The zone identifier accepted anywhere one is persisted.
 *
 * Bounded at 64 characters: the longest identifiers in tzdata are around 30
 * (`America/Argentina/ComodRivadavia`), and the column is 50 in the schema
 * that predates this — the schema's own limit still applies underneath.
 */
export const TimezoneSchema = z
  .string()
  .max(50)
  .refine(isValidTimezone, { message: 'Identifiant de fuseau horaire IANA invalide.' });

/** Last resort only, when the browser cannot supply a usable zone. */
export const FALLBACK_TIMEZONE = 'Europe/Paris';

/**
 * The zone to preselect when creating an event.
 *
 * `resolvedOptions().timeZone` is the operator's own zone, which is right far
 * more often than any constant. It is validated rather than trusted: a
 * browser may report something the shape test rejects, or nothing at all.
 *
 * The resolver is injected so the fallback path can be exercised without a
 * browser and without stubbing globals.
 */
export function detectDefaultTimezone(
  resolve: () => string | undefined = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }
): string {
  let detected: string | undefined;
  try {
    detected = resolve();
  } catch {
    detected = undefined;
  }
  return isValidTimezone(detected) ? detected : FALLBACK_TIMEZONE;
}

/**
 * Every zone this engine can offer, for a searchable selector.
 *
 * `Intl.supportedValuesOf` is not universal, so a caller must be able to
 * cope with an empty list by falling back to free entry validated by
 * `isValidTimezone`.
 */
export function supportedTimezones(): string[] {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof supported !== 'function') return [];
    return supported.call(Intl, 'timeZone');
  } catch {
    return [];
  }
}
