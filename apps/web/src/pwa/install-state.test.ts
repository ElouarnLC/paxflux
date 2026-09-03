import { describe, expect, it } from 'vitest';
import { describeInstallState, detectStandalone, shouldOfferInstall } from './install-state.js';

/**
 * Browser-state detection, argued with directly.
 *
 * Every case here is one Playwright cannot stage: a real installed
 * application, a browser with no install API, Safari's own signal. The
 * decision is therefore a pure function fed by the hook, and this is where
 * it is held to account.
 */

describe('describeInstallState', () => {
  it('offers nothing to an already-installed application', () => {
    // Checked before the prompt: a browser can still fire
    // `beforeinstallprompt` inside an installed window, and offering to
    // install an application from inside itself is the worst outcome here.
    expect(describeInstallState({ standalone: true, promptAvailable: true })).toBe('installed');
    expect(describeInstallState({ standalone: true, promptAvailable: false })).toBe('installed');
  });

  it('offers the action only when the browser has really given one', () => {
    expect(describeInstallState({ standalone: false, promptAvailable: true })).toBe('available');
  });

  it('says nothing when there is no prompt to show', () => {
    // Indistinguishable from here: no install API at all (every iOS
    // browser), or criteria unmet — most often a plain-HTTP LAN origin.
    // Both are treated the same way, which is silence.
    expect(describeInstallState({ standalone: false, promptAvailable: false })).toBe('unavailable');
  });
});

describe('shouldOfferInstall', () => {
  it('is true for exactly one state', () => {
    expect(shouldOfferInstall('available')).toBe(true);
    expect(shouldOfferInstall('installed')).toBe(false);
    expect(shouldOfferInstall('unavailable')).toBe(false);
  });
});

describe('detectStandalone', () => {
  const matcher = (matching: string[]) => (query: string) => ({ matches: matching.includes(query) });

  it('reads the standard display-mode signal', () => {
    expect(detectStandalone(matcher(['(display-mode: standalone)']), undefined)).toBe(true);
  });

  it('accepts the other installed display modes', () => {
    // If the manifest ever moves off `standalone`, a window in `minimal-ui`
    // or `fullscreen` is still an installed one.
    expect(detectStandalone(matcher(['(display-mode: minimal-ui)']), undefined)).toBe(true);
    expect(detectStandalone(matcher(['(display-mode: fullscreen)']), undefined)).toBe(true);
  });

  it('reads Safari’s own signal, which is the only one iOS gives', () => {
    expect(detectStandalone(matcher([]), true)).toBe(true);
    // And does not mistake its absence, or a falsy value, for a positive.
    expect(detectStandalone(matcher([]), undefined)).toBe(false);
    expect(detectStandalone(matcher([]), false)).toBe(false);
  });

  it('reports a browser tab as not installed', () => {
    expect(detectStandalone(matcher(['(display-mode: browser)']), undefined)).toBe(false);
  });

  it('survives an environment with no matchMedia at all', () => {
    expect(detectStandalone(undefined, undefined)).toBe(false);
  });

  it('survives a webview that throws on an unknown media query', () => {
    const throwing = () => {
      throw new Error('unsupported media query');
    };
    expect(detectStandalone(throwing, undefined)).toBe(false);
  });
});
