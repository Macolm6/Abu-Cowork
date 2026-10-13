import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BuildEnvironment, createIdResolver, normalizePath, resolveConfig } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A file of the application, and a file of the overlay beside this checkout. Neither is read:
// a resolution only needs to know where the import was written.
const hostFile = path.join(root, 'src/stores/chatStore.ts');
const overlayFile = path.resolve(root, '../Abu-enterprise-modules/src/index.ts');

function inPackage(file: string): string {
  return normalizePath(path.join(root, 'node_modules', file));
}

// The production build's own resolution of an import, under the enterprise build target.
describe('shared packages in the enterprise build', () => {
  let resolve: (source: string, importer: string) => Promise<string | undefined>;

  beforeAll(async () => {
    vi.stubEnv('ABU_BUILD_TARGET', 'enterprise');
    const config = await resolveConfig({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'silent' }, 'build');
    const environment = new BuildEnvironment('client', config);
    const resolver = createIdResolver(config);
    resolve = async (source, importer) => (await resolver(environment, source, importer))?.replace(/\?.*$/, '');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  // The immer middleware as an ES module imports the copy of immer the stores import. Its
  // CommonJS file requires immer's CommonJS build, a second copy whose drafts the stores'
  // `current()` cannot read.
  it('takes the entry each package exports for an import, from the application and from the overlay alike', async () => {
    const entries: Array<[string, string]> = [
      ['zustand', 'zustand/esm/index.mjs'],
      ['zustand/middleware', 'zustand/esm/middleware.mjs'],
      ['zustand/middleware/immer', 'zustand/esm/middleware/immer.mjs'],
      ['zustand/react/shallow', 'zustand/esm/react/shallow.mjs'],
    ];
    for (const [source, file] of entries) {
      expect(await resolve(source, hostFile), `${source} from the application`).toBe(inPackage(file));
      expect(await resolve(source, overlayFile), `${source} from the overlay`).toBe(inPackage(file));
    }
  });

  it('gives the immer middleware the copy of immer the stores import', async () => {
    const fromStore = await resolve('immer', hostFile);
    expect(fromStore).toBe(inPackage('immer/dist/immer.mjs'));
    expect(await resolve('immer', inPackage('zustand/esm/middleware/immer.mjs'))).toBe(fromStore);
  });

  it('resolves every other shared package for the overlay to the file the application gets', async () => {
    const sources = [
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
      '@noble/curves/ed25519', '@noble/hashes/sha2',
      '@tauri-apps/api/core', '@tauri-apps/api/path',
      '@tauri-apps/plugin-deep-link', '@tauri-apps/plugin-fs', '@tauri-apps/plugin-http', '@tauri-apps/plugin-opener',
      'fflate', 'lucide-react',
    ];
    for (const source of sources) {
      const fromHost = await resolve(source, hostFile);
      expect(fromHost, `${source} from the application`).toContain(inPackage(''));
      expect(await resolve(source, overlayFile), `${source} from the overlay`).toBe(fromHost);
    }
  });
});
