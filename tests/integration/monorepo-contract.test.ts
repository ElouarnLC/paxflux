import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Repository contract tests.
 *
 * These do not exercise the running product: they pin properties of the
 * repository that a developer or an operator relies on, and that nothing else
 * would catch until it hurt someone on a clean checkout.
 */

const repoRoot = path.resolve(process.cwd());

function readJson(relPath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf-8'));
}

describe('every public command that consumes @paxflux/shared is clean-checkout safe', () => {
  /**
   * `packages/shared` publishes its interface from `dist` ("main", "types" and
   * "exports" all point there). A fresh clone has no `dist`, so the server tsc,
   * the web tsc, Vite, Vitest and tsx alike fail to resolve `@paxflux/shared`
   * until it is built once.
   *
   * Phase 9 fixed that for the gate commands by declaring the dependency with
   * npm's own pre-script mechanism; Phase 10 extended it to the dev commands.
   * The point of this test is that the *next* script someone adds cannot
   * silently reintroduce the trap: a root script that reaches a workspace
   * depending on @paxflux/shared must be preceded by the shared build.
   */
  const rootPkg = readJson('package.json');
  const scripts: Record<string, string> = rootPkg.scripts;

  const SHARED_BUILD = 'npm run build:shared';

  it('exposes a single build:shared script the guards can point at', () => {
    expect(scripts['build:shared']).toBe('npm run build -w @paxflux/shared');
  });

  /**
   * The workspaces that import @paxflux/shared. Derived from their manifests
   * rather than hardcoded, so a new consumer is picked up automatically.
   */
  const consumingWorkspaces = ['packages/shared', 'apps/server', 'apps/web'].filter((w) => {
    const pkg = readJson(path.join(w, 'package.json'));
    return Boolean(pkg.dependencies?.['@paxflux/shared']);
  });

  it('finds the workspaces that depend on the shared package', () => {
    expect(consumingWorkspaces).toEqual(['apps/server', 'apps/web']);
  });

  /**
   * A root script "reaches" a consuming workspace when it delegates to it with
   * `-w <name>`, or runs a tool (vitest, playwright, node on a built server)
   * whose module graph goes through one.
   */
  const reachesConsumer = (command: string): boolean => {
    if (/-w @paxflux\/(server|web)\b/.test(command)) return true;
    if (/\b(vitest|playwright|tsx)\b/.test(command)) return true;
    return false;
  };

  /**
   * A command is safe when the shared build runs before it: directly, or
   * through one level of `npm run <script>` indirection (`pretest:e2e` reaches
   * it through `npm run build`, which starts with `build:shared`).
   */
  const buildsShared = (command: string | undefined, depth = 0): boolean => {
    if (!command || depth > 3) return false;
    if (command.includes(SHARED_BUILD)) return true;
    return [...command.matchAll(/npm run ([\w:-]+)/g)].some(([, referenced]) =>
      buildsShared(scripts[referenced], depth + 1)
    );
  };

  const guarded = (name: string): boolean =>
    buildsShared(scripts[`pre${name}`]) || buildsShared(scripts[name]);

  const unguarded = Object.entries(scripts)
    .filter(([name]) => !name.startsWith('pre'))
    .filter(([, command]) => reachesConsumer(command))
    .filter(([name]) => !guarded(name))
    .map(([name]) => name);

  it('leaves no public command that needs the shared build without one', () => {
    expect(
      unguarded,
      `these root scripts reach a workspace that imports @paxflux/shared but ` +
        `nothing builds it first, so they break on a fresh clone: ${unguarded.join(', ')}`
    ).toEqual([]);
  });

  it.each(['typecheck', 'test', 'dev', 'dev:server', 'dev:web'])(
    '`npm run %s` builds the shared package first',
    (name) => {
      expect(guarded(name)).toBe(true);
    }
  );
});

describe('licence metadata is coherent across the repository', () => {
  /**
   * Before Phase 10 the README advertised MIT, package.json declared
   * Apache-2.0, and no LICENSE file existed at all. The owner confirmed
   * Apache-2.0, so nothing may drift back.
   */
  const EXPECTED = 'Apache-2.0';

  it('ships a LICENSE file carrying the Apache 2.0 text', () => {
    const licensePath = path.join(repoRoot, 'LICENSE');
    expect(fs.existsSync(licensePath)).toBe(true);
    const text = fs.readFileSync(licensePath, 'utf-8');
    expect(text).toContain('Apache License');
    expect(text).toContain('Version 2.0, January 2004');
    expect(text).toContain('http://www.apache.org/licenses/LICENSE-2.0');
  });

  it.each(['package.json', 'packages/shared/package.json', 'apps/server/package.json', 'apps/web/package.json'])(
    '%s declares the same licence',
    (manifest) => {
      expect(readJson(manifest).license).toBe(EXPECTED);
    }
  );

  it('does not advertise a different licence in the README', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf-8');
    expect(readme).not.toMatch(/\bMIT\b/);
    expect(readme).toContain(EXPECTED);
  });
});
