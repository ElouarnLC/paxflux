/**
 * Whether this browser can install PaxFlux, and whether it already has.
 *
 * Pure and separated from the hook that feeds it, because every interesting
 * case here is a browser state that is hard to reach in a test and easy to
 * get wrong by guessing: a phone already running the installed application,
 * a browser with no install API at all, and an origin that will never be
 * installable because it is not a secure context.
 *
 * PaxFlux cannot make a browser install anything. What it can do is not lie
 * about it — no CTA where installation is impossible, no claim of success
 * the browser has not confirmed, and no vendor hacks to force a prompt that
 * the browser has decided not to offer.
 */

export type InstallState =
  /** Already running as an installed application. Nothing to offer. */
  | 'installed'
  /** The browser has offered a real prompt and it has not been used yet. */
  | 'available'
  /**
   * No prompt to show.
   *
   * Either the browser has no install API (every iOS browser, and Firefox on
   * the desktop), or the criteria are not met — most often because the origin
   * is plain HTTP on something other than loopback. Indistinguishable from
   * here, and treated the same way: say nothing.
   */
  | 'unavailable';

export interface InstallInputs {
  /** The page is running in a standalone window rather than a browser tab. */
  standalone: boolean;
  /** A `beforeinstallprompt` event has been captured and not yet consumed. */
  promptAvailable: boolean;
}

export function describeInstallState({ standalone, promptAvailable }: InstallInputs): InstallState {
  // Checked first: a browser can still fire `beforeinstallprompt` in an
  // installed window in some configurations, and offering to install an
  // application from inside itself is the most obviously wrong thing here.
  if (standalone) return 'installed';
  return promptAvailable ? 'available' : 'unavailable';
}

/** Only one state is worth a button. */
export function shouldOfferInstall(state: InstallState): boolean {
  return state === 'available';
}

/**
 * Whether this page is running as an installed application.
 *
 * Two signals because the platforms disagree. `display-mode: standalone`
 * is the standard one; `navigator.standalone` is Safari's, is the only
 * signal iOS gives, and is absent everywhere else — so it is read
 * defensively rather than typed into the global `Navigator`.
 *
 * Both are injected so the branches are testable without a browser.
 */
export function detectStandalone(
  matchMedia: ((query: string) => { matches: boolean }) | undefined,
  legacyStandalone: unknown
): boolean {
  if (legacyStandalone === true) return true;
  if (!matchMedia) return false;
  try {
    // `minimal-ui` and `fullscreen` are the other display modes an installed
    // PaxFlux could end up in if the manifest ever changes; a window in any
    // of them is installed, whatever the manifest asked for.
    return (
      matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: minimal-ui)').matches ||
      matchMedia('(display-mode: fullscreen)').matches
    );
  } catch {
    // Some embedded webviews throw on an unrecognised media query rather
    // than reporting no match.
    return false;
  }
}

/**
 * The subset of `BeforeInstallPromptEvent` that is actually used.
 *
 * Declared here rather than reached for from `lib.dom`, which does not
 * define it: it is a Chromium extension to the standard, and typing it
 * locally is honest about that.
 */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
