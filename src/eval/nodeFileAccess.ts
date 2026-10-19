/**
 * Node-backed implementations of the two file interfaces the file-edit eval
 * needs: the `ToolFileAccess` object the real file tools do their I/O
 * through (the Electron host provides one per tool call in the app; here the
 * eval is the trusted host), and the `EvalWorkspace` the runner uses to lay
 * out and read back each case.
 *
 * Only used by the CLI (`run.ts`); the runner's logic is unit-tested against
 * in-memory implementations of the same interfaces.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import type { FsDirEntry, FsStat } from '@/core/tools/fsBridge';
import type { EvalWorkspace } from './fileEditRunner';

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function readDirEntries(path: string): Promise<FsDirEntry[]> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
    isSymlink: entry.isSymbolicLink(),
  }));
}

async function* walk(
  root: string,
  options: { excludeNames?: readonly string[]; skipHiddenDirectories?: boolean; skipSymlinks?: boolean; maxDepth?: number },
  depth = 0,
): AsyncGenerator<{ path: string; name: string }> {
  if (options.maxDepth !== undefined && depth > options.maxDepth) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (options.excludeNames?.includes(entry.name)) continue;
    if (entry.isSymbolicLink() && options.skipSymlinks) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (options.skipHiddenDirectories && entry.name.startsWith('.')) continue;
      yield* walk(full, options, depth + 1);
    } else if (entry.isFile()) {
      yield { path: full, name: entry.name };
    }
  }
}

function unavailable(operation: string): never {
  throw new Error(`${operation} is not available in the file-edit eval runner`);
}

export function createNodeFileAccess(): ToolFileAccess {
  const guard = { assertCurrent: async () => {}, assertActive: () => {} };
  return {
    executionInput: {},
    originalPath: (path) => path,
    originalPathIfKnown: (path) => path,
    prepare: async () => {},
    assertCurrent: guard.assertCurrent,
    assertActive: guard.assertActive,
    resultGuard: () => guard,
    async stat(path): Promise<FsStat> {
      const info = await fs.stat(path);
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), isSymlink: false, size: info.size, mtime: info.mtime };
    },
    exists: pathExists,
    readTextFile: (path) => fs.readFile(path, 'utf-8'),
    readFile: async (path) => new Uint8Array(await fs.readFile(path)),
    processImage: () => unavailable('processImage'),
    runProcessor: () => unavailable('runProcessor'),
    openDocument: () => unavailable('openDocument'),
    writeTextFile: (path, text) => fs.writeFile(path, text, 'utf-8'),
    writeFile: (path, bytes) => fs.writeFile(path, bytes),
    ensureParentDir: async (path) => {
      await fs.mkdir(dirname(path), { recursive: true });
    },
    readDir: readDirEntries,
    walkFiles: (path, options = {}) => walk(path, options),
    async searchLines(path, pattern, maxResults) {
      const regex = new RegExp(pattern);
      const text = await fs.readFile(path, 'utf-8');
      const matches: Array<{ lineNumber: number; line: string }> = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (regex.test(lines[i])) matches.push({ lineNumber: i + 1, line: lines[i] });
      }
      return { searchable: true, matches, bytesRead: Buffer.byteLength(text, 'utf-8') };
    },
    prepareDelete: () => unavailable('prepareDelete'),
    moveToTrash: () => unavailable('moveToTrash'),
    dispose: async () => {},
  };
}

export function createNodeEvalWorkspace(rootDir: string): EvalWorkspace {
  return {
    caseDir: (caseId) => join(rootDir, caseId),
    async prepare(caseId, files) {
      const dir = join(rootDir, caseId);
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      for (const [relativePath, content] of Object.entries(files)) {
        const full = join(dir, relativePath);
        await fs.mkdir(dirname(full), { recursive: true });
        await fs.writeFile(full, content, 'utf-8');
      }
    },
    async readText(absolutePath) {
      if (!(await pathExists(absolutePath))) return null;
      return fs.readFile(absolutePath, 'utf-8');
    },
    async listFiles(dir) {
      const found: string[] = [];
      for await (const entry of walk(dir, {})) {
        found.push(relative(dir, entry.path).split('\\').join('/'));
      }
      return found;
    },
  };
}
