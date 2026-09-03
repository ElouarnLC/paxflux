/**
 * Vibration, and what the browser will actually admit about it.
 *
 * Counting has never depended on this and must not start: `handleTap`
 * enqueues the movement whatever happens here, and every call in the
 * counting path stays fire-and-forget. What was missing is the *diagnostic* —
 * an operator whose phone stayed silent had no way to tell a browser without
 * the API (every iOS browser) from a phone whose haptics the user has turned
 * off, and support was left guessing at a handset they cannot hold.
 *
 * So the outcome is modelled instead of discarded:
 *
 *   unsupported  no `navigator.vibrate` at all — nothing to switch on
 *   accepted     the browser took the request
 *   refused      the browser declined it, or threw trying
 *
 * The honest limit is that `accepted` is not proof of a felt buzz. The spec
 * lets a user agent return `true` and vibrate nothing — a silent-mode phone,
 * a backgrounded tab, a device with no motor. Nothing in the platform
 * reports that back, so the wording below never claims the operator felt
 * anything; it says what was requested and asks them.
 */

/** The three things a vibration request can turn out to be. */
export type HapticOutcome = 'unsupported' | 'accepted' | 'refused';

/** `navigator.vibrate`, narrowed to what is actually called. */
export type Vibrator = (pattern: number | number[]) => boolean;

/**
 * Reads the vibration API off a navigator, or reports its absence.
 *
 * Injected rather than read from the global so the absent case is reachable
 * in a test: `navigator.vibrate` cannot be deleted in every environment, and
 * a test that cannot express "this browser is an iPhone" is not testing the
 * branch that matters most.
 */
export function resolveVibrator(nav: Navigator | undefined | null): Vibrator | null {
  if (!nav || typeof nav.vibrate !== 'function') return null;
  // Bound: some engines throw an illegal-invocation TypeError on a detached
  // `vibrate`, which would be reported as `refused` on a browser that in
  // fact supports it perfectly.
  return (pattern) => nav.vibrate(pattern);
}

/**
 * Requests a vibration and says what became of it.
 *
 * Total by construction: an absent API, a `false` return and a throw are all
 * ordinary results here. Nothing escapes — this is called from a tap handler
 * whose real work is recording a movement, and a haptic failure has no
 * business interrupting that.
 */
export function requestVibration(vibrator: Vibrator | null, pattern: number | number[]): HapticOutcome {
  if (!vibrator) return 'unsupported';
  try {
    // The spec returns false when the request is declined — a pattern the
    // user agent will not honour, or a document without the user activation
    // or visibility it requires.
    return vibrator(pattern) ? 'accepted' : 'refused';
  } catch {
    // Firefox and some Android browsers throw when the user has disabled
    // vibration outright. Indistinguishable from a refusal to the operator,
    // and treated as one.
    return 'refused';
  }
}

/**
 * The same request against the real browser, for callers that have no reason
 * to inject one.
 */
export function vibrate(pattern: number | number[]): HapticOutcome {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return requestVibration(resolveVibrator(nav), pattern);
}

/** A short double pulse: long enough to feel, short enough not to buzz on. */
export const HAPTIC_TEST_PATTERN: number[] = [40, 60, 40];

export interface HapticReport {
  outcome: HapticOutcome;
  /** What to tell the operator, in the terms they can act on. */
  message: string;
  /** Whether this is a problem or merely a fact about the handset. */
  tone: 'success' | 'warning' | 'info';
}

/**
 * What the operator is told after pressing `Tester la vibration`.
 *
 * Every branch ends by saying counting works regardless, because the
 * question this button answers is "is my phone broken?" and the answer is
 * never "you cannot use PaxFlux".
 */
export function describeHapticOutcome(outcome: HapticOutcome): HapticReport {
  switch (outcome) {
    case 'accepted':
      return {
        outcome,
        tone: 'success',
        // Deliberately not "vibration réussie": the browser confirmed it
        // accepted the request, not that the phone moved.
        message:
          'Vibration demandée. Si vous n’avez rien senti, vérifiez le mode silencieux et le retour haptique du téléphone. Le comptage fonctionne sans vibration.',
      };
    case 'refused':
      return {
        outcome,
        tone: 'warning',
        message:
          'Vibration refusée par le navigateur, souvent parce qu’elle est désactivée dans les réglages du téléphone. Le comptage fonctionne sans vibration.',
      };
    case 'unsupported':
      return {
        outcome,
        tone: 'info',
        message:
          'Ce navigateur ne propose pas la vibration, notamment sur iPhone. Le comptage fonctionne sans vibration.',
      };
  }
}
