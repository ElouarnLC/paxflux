import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Documentation contract tests.
 *
 * A stale claim in a document is not a cosmetic problem when the claim is
 * "accepted for production" or a set of test counts from five phases ago:
 * someone reads it and deploys on the strength of it. These pin the three
 * statements RC2-E had to correct, so the next change cannot quietly put
 * them back.
 *
 * They read files, not the product — deliberately narrow. Nothing here
 * checks prose quality; each assertion is about a specific factual claim.
 */

const repoRoot = path.resolve(process.cwd());
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

describe('the acceptance report does not present Phase 10 as current', () => {
  const report = read('docs/ACCEPTANCE_REPORT.md');

  const historicalAt = report.indexOf('# Part II — Phase 10 acceptance (historical');

  it('states the current status as field acceptance, not production', () => {
    expect(report).toContain('READY FOR PHYSICAL RC2 FIELD ACCEPTANCE');

    // The 2026-08-29 document certified "ACCEPTED & READY FOR PRODUCTION"
    // against the pre-remediation alpha, and Part II quotes that in saying
    // what it replaced — so the phrase may exist, but only behind the
    // historical marker. In front of it, it would be a live claim.
    expect(historicalAt, 'Part II must exist and be labelled historical').toBeGreaterThan(0);
    for (let at = report.indexOf('READY FOR PRODUCTION'); at !== -1; ) {
      expect(at, 'a production-readiness claim appears in the current part').toBeGreaterThan(historicalAt);
      at = report.indexOf('READY FOR PRODUCTION', at + 1);
    }
  });

  it('keeps the Phase 10 test counts inside the part labelled historical', () => {
    // 245 Vitest / 229 Playwright were measured on 3fcb8d37. They may appear
    // — the evidence is worth keeping — but never in the part a reader takes
    // for the current state of the product.
    for (const count of ['245 / 245', '229 / 229']) {
      const at = report.indexOf(count);
      if (at === -1) continue;
      expect(at, `"${count}" appears in Part I, where it reads as current`).toBeGreaterThan(historicalAt);
    }
  });

  it('does not claim to state its own commit', () => {
    // A document cannot name its own SHA: writing it changes the file. The
    // previous wording said "measured on this pull request's head" beside a
    // SHA that a later documentation commit had already superseded.
    const current = report.slice(0, historicalAt);
    expect(current).not.toContain("Measured on this pull request's head");
    expect(current).toContain('RC2-E functional evidence commit');
    // And it says where the authoritative answers actually live.
    expect(current).toContain('final required-check status of the pull request');
    expect(current).toContain('The merge commit');
  });

  it('points at the physical runbook and calls it pending, in the current part', () => {
    const current = report.slice(0, historicalAt);
    expect(current).toContain('FIELD_ACCEPTANCE_RC2.md');
    expect(current).toContain('PENDING');
    expect(current).toContain('No physical acceptance has been performed');
  });
});

describe('the field acceptance runbook is a runbook, not a result', () => {
  const runbook = read('docs/FIELD_ACCEPTANCE_RC2.md');

  it('announces that nothing has been run', () => {
    expect(runbook).toContain('Physical acceptance status: **PENDING**');
  });

  it('leaves every step unmarked', () => {
    // Each step row ends `| <type> | <result> | <notes> |`. Until someone
    // physically runs this, every result is NOT RUN — a PASS here would be a
    // fabricated observation, which is the one thing this document must not
    // become by accident.
    const stepRows = runbook
      .split('\n')
      .filter((line) => /^\| \d+ \|/.test(line));

    expect(stepRows.length, 'the runbook must have numbered steps').toBeGreaterThanOrEqual(20);
    for (const row of stepRows) {
      const cells = row.split('|').map((c) => c.trim());
      const result = cells[cells.length - 3];
      expect(result, `step row marked "${result}": ${row.slice(0, 60)}…`).toBe('NOT RUN');
    }
  });

  it('separates release gates from device capability', () => {
    const stepRows = runbook.split('\n').filter((line) => /^\| \d+ \|/.test(line));
    const types = stepRows.map((row) => {
      const cells = row.split('|').map((c) => c.trim());
      return cells[cells.length - 4];
    });
    // Vibration support is a browser capability and must not block rc.2;
    // installing over HTTPS is a gate. Both kinds have to be present for the
    // distinction to mean anything.
    expect(types.some((t) => t.startsWith('GATE'))).toBe(true);
    expect(types.some((t) => t.startsWith('OBS'))).toBe(true);
  });

  it('does not treat a missing JavaScript prompt as an unsupported platform', () => {
    // The review round that added this: iOS has no `beforeinstallprompt` and
    // installs web apps manually through Safari, so reading the prompt's
    // absence as NOT SUPPORTED would mark the whole iPhone fleet
    // untestable — and a physical acceptance where every field handset is
    // NOT SUPPORTED for installation has demonstrated nothing.
    const flat = runbook.replace(/\s+/g, ' ');
    expect(flat).toContain('Add to Home Screen');
    expect(flat).toContain('A missing `beforeinstallprompt` on iOS Safari is **not** that');
    expect(flat, 'at least one target handset must actually pass').toContain(
      'At least one representative target handset and browser must PASS step 9'
    );
  });

  it('keeps installation and service-worker registration as separate lifecycles', () => {
    const flat = runbook.replace(/\s+/g, ' ');
    // Installing does not create a service worker; HTTPS plus a successful
    // registration does, in an ordinary tab. Installation is required here
    // for the standalone launch, which is a different claim.
    expect(flat).toContain('is *not* "how the phone gets a service worker"');
    expect(flat).toContain('standalone field launch experience');
  });

  it('warns against pasting credentials into the evidence', () => {
    // Collapsed, because the sentence is wrapped in the source.
    const flat = runbook.replace(/\s+/g, ' ');
    expect(flat).toContain('A pairing token is a credential');
    expect(flat).toContain('Never paste a pairing URL');
  });
});

describe('the restore comment describes what a failure actually leaves behind', () => {
  const source = read('apps/server/src/backups/backup-service.ts');

  it('no longer claims the instance is untouched whatever fails', () => {
    // Issue #11. False after the promotion rename, which is precisely the
    // failure an operator must not misread as "nothing happened".
    expect(source).not.toContain('the instance still holds exactly what it held before');
  });

  it('distinguishes a failure before promotion from one after it', () => {
    expect(source).toContain('before promotion');
    expect(source).toContain('after promotion');
    // And the code still carries the flag the comment is about.
    expect(source).toContain('readonly promoted: boolean');
  });
});
