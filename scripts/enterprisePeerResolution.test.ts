import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, normalizePath, type ViteDevServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A file of the application, and a file of the overlay beside this checkout. Neither is read:
// a resolution only needs to know where the import was written.
const hostFile = path.join(root, 'src/stores/chatStore.ts');
const overlayFile = path.resolve(root, '../Abu-enterprise-modules/src/index.ts');

function inPackage(file: string): string {
  return normalizePath(path.join(root, 'node_modules', file));
}

describe('shared packages in the enterprise build', () => {
  let server: ViteDevServer;

  async function resolve(source: string, importer: string): Promise<string | undefined> {
    const resolved = await server.environments.client.pluginContainer.resolveId(source, importer);
    return resolved?.id.replace(/\?.*$/, '');
  }

  beforeAll(async () => {
    vi.stubEnv('ABU_BUILD_TARGET', 'enterprise');
    server = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      logLevel: 'silent',
      server: { middlewareMode: true, ws: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
  });

  afterAll(async () => {
    await server.close();
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
      expect(fromHost, `${source} from the application`).toMatch(/\/node_modules\//);
      expect(await resolve(source, overlayFile), `${source} from the overlay`).toBe(fromHost);
    }
  });
});
