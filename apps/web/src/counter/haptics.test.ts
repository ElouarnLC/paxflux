import { describe, expect, it, vi } from 'vitest';
import {
  HAPTIC_TEST_PATTERN,
  Vibrator,
  describeHapticOutcome,
  requestVibration,
  resolveVibrator,
} from './haptics.js';

/**
 * The four things a browser does when asked to vibrate, and the one thing
 * PaxFlux must do in all four: keep counting.
 */

describe('what the browser says when asked to vibrate', () => {
  it('reports a browser without the API as unsupported, and never calls anything', () => {
    // Every iOS browser. Not a failure and not worth a warning tone.
    expect(requestVibration(null, 25)).toBe('unsupported');
  });

  it('reports an accepted request as accepted', () => {
    const vibrator = vi.fn<Vibrator>(() => true);
    expect(requestVibration(vibrator, 25)).toBe('accepted');
    expect(vibrator).toHaveBeenCalledWith(25);
  });

  it('reports a declined request as refused', () => {
    // The spec's own path: a user agent that will not honour the pattern, or
    // a document lacking the activation or visibility it requires.
    expect(requestVibration(() => false, 25)).toBe('refused');
  });

  it('reports a throwing implementation as refused rather than letting it escape', () => {
    // Firefox and some Android browsers throw when the user has switched
    // vibration off. This is called from the tap handler, so an exception
    // here would abort recording a movement — the one outcome that is not
    // acceptable.
    const vibrator = () => {
      throw new TypeError('vibration disabled by the user');
    };
    expect(() => requestVibration(vibrator, HAPTIC_TEST_PATTERN)).not.toThrow();
    expect(requestVibration(vibrator, HAPTIC_TEST_PATTERN)).toBe('refused');
  });

  it('passes a pattern through unchanged', () => {
    const vibrator = vi.fn<Vibrator>(() => true);
    requestVibration(vibrator, HAPTIC_TEST_PATTERN);
    expect(vibrator).toHaveBeenCalledWith([40, 60, 40]);
  });
});

describe('reading the API off a navigator', () => {
  it('treats a navigator without vibrate as no vibrator at all', () => {
    expect(resolveVibrator({} as Navigator)).toBeNull();
    expect(resolveVibrator(undefined)).toBeNull();
    expect(resolveVibrator(null)).toBeNull();
  });

  it('calls the API with the navigator as its receiver', () => {
    // A detached `navigator.vibrate` throws an illegal-invocation TypeError
    // in some engines, which `requestVibration` would then report as
    // `refused` on a browser that supports vibration perfectly well.
    const nav = {
      vibrate(this: unknown, pattern: number | number[]): boolean {
        return this === nav && pattern === 25;
      },
    } as unknown as Navigator;

    expect(requestVibration(resolveVibrator(nav), 25)).toBe('accepted');
  });
});

describe('what the operator is told', () => {
  it('never claims the phone actually buzzed', () => {
    // `true` means the request was accepted. A silent-mode phone, a device
    // with no motor and a backgrounded tab all return it too, so promising
    // a felt vibration would be a lie the platform cannot back up.
    const report = describeHapticOutcome('accepted');
    expect(report.tone).toBe('success');
    expect(report.message).toContain('Vibration demandée');
    expect(report.message).not.toContain('réussie');
    expect(report.message).toContain('Si vous n’avez rien senti');
  });

  it('points a refusal at the phone settings that cause it', () => {
    const report = describeHapticOutcome('refused');
    expect(report.tone).toBe('warning');
    expect(report.message).toContain('réglages du téléphone');
  });

  it('states an absent API as a fact, not a fault', () => {
    const report = describeHapticOutcome('unsupported');
    expect(report.tone).toBe('info');
    expect(report.message).toContain('iPhone');
  });

  it('tells the operator counting works, whatever the outcome', () => {
    // The question this diagnostic answers is "is my phone broken?", and the
    // answer is never "you cannot use PaxFlux".
    for (const outcome of ['accepted', 'refused', 'unsupported'] as const) {
      expect(describeHapticOutcome(outcome).message).toContain('Le comptage fonctionne sans vibration');
    }
  });
});
