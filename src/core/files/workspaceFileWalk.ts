/**
 * The walk behind `fs.listWorkspaceFiles`: every regular file under a
 * workspace folder with its size and modification time. The sidecar host and
 * the renderer's local path run this same function over their own `readDir`
 * and `stat`. This module imports nothing, so both tiers can bundle it.
 */

export const WORKSPACE_LIST_MAX_ENTRIES = 20000;
export const WORKSPACE_LIST_MAX_DEPTH = 12;

/** Directory names the walk does not enter, at any depth. Any directory whose name starts with a dot is skipped as well. */
export const SKIPPED_WORKSPACE_DIRECTORIES: readonly string[] = [
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.DS_Store', 'dist', 'build', '.next', '.cache', 'target',
];

/** File names the walk leaves out. */
const SKIPPED_FILE_NAMES: readonly string[] = ['.DS_Store'];

/** Files of one directory whose `stat` calls run together. */
const STAT_BATCH_SIZE = 64;

export interface WorkspaceFileEntry {
  /** Relative to the root, '/' separators. */
  path: string;
  size: number;
  /** Whole milliseconds since the epoch; null when the platform reports none. */
  mtimeMs: number | null;
}

export type WorkspaceFileList =
  | { exceeded: false; files: WorkspaceFileEntry[] }
  /** The folder holds more files than `maxEntries`. */
  | { exceeded: true };

export interface WorkspaceListLimits {
  maxEntries: number;
  /** Directory levels entered below the root; 0 lists the root's own files only. */
  maxDepth: number;
}

export interface WorkspaceWalkDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface WorkspaceWalkIo {
  /** Entry types come from the directory entry itself; a link reports `isSymlink` and neither of the other two. */
  readDir(path: string): Promise<WorkspaceWalkDirEntry[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number | null }>;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Limits as they arrive over the wire. A missing limit takes the default; a
 * limit that is no positive integer, or is above the default, yields null.
 */
export function parseWorkspaceListLimits(value: unknown): WorkspaceListLimits | null {
  if (value === undefined) return { maxEntries: WORKSPACE_LIST_MAX_ENTRIES, maxDepth: WORKSPACE_LIST_MAX_DEPTH };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const maxEntries = raw.maxEntries === undefined ? WORKSPACE_LIST_MAX_ENTRIES : raw.maxEntries;
  const maxDepth = raw.maxDepth === undefined ? WORKSPACE_LIST_MAX_DEPTH : raw.maxDepth;
  if (!isPositiveInteger(maxEntries) || maxEntries > WORKSPACE_LIST_MAX_ENTRIES) return null;
  if (!isPositiveInteger(maxDepth) || maxDepth > WORKSPACE_LIST_MAX_DEPTH) return null;
  return { maxEntries, maxDepth };
}

function normalizeRoot(root: string): string {
  const slashed = root.replace(/\\/g, '/');
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

function isSkippedDirectory(name: string): boolean {
  return name.startsWith('.') || SKIPPED_WORKSPACE_DIRECTORIES.includes(name);
}

function comparePaths(a: WorkspaceFileEntry, b: WorkspaceFileEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Lists the regular files under `root`. Symbolic links are neither listed nor
 * followed. The walk stops with `{ exceeded: true }` as soon as it has seen
 * more than `maxEntries` files.
 */
export async function walkWorkspaceFiles(
  root: string,
  limits: WorkspaceListLimits,
  io: WorkspaceWalkIo,
): Promise<WorkspaceFileList> {
  const base = normalizeRoot(root);
  const files: WorkspaceFileEntry[] = [];
  const pending: Array<{ relative: string; depth: number }> = [{ relative: '', depth: 0 }];

  while (pending.length > 0) {
    const directory = pending.pop() as { relative: string; depth: number };
    const absolute = directory.relative ? `${base}/${directory.relative}` : base;
    const entries = await io.readDir(absolute);
    const fileNames: string[] = [];
    for (const entry of entries) {
      if (entry.isSymlink) continue;
      const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (directory.depth < limits.maxDepth && !isSkippedDirectory(entry.name)) {
          pending.push({ relative, depth: directory.depth + 1 });
        }
      } else if (entry.isFile && !SKIPPED_FILE_NAMES.includes(entry.name)) {
        fileNames.push(relative);
      }
    }

    if (files.length + fileNames.length > limits.maxEntries) return { exceeded: true };
    for (let start = 0; start < fileNames.length; start += STAT_BATCH_SIZE) {
      const batch = fileNames.slice(start, start + STAT_BATCH_SIZE);
      const stats = await Promise.all(batch.map((relative) => io.stat(`${base}/${relative}`)));
      stats.forEach((info, index) => {
        files.push({
          path: batch[index],
          size: info.size,
          mtimeMs: info.mtimeMs === null ? null : Math.floor(info.mtimeMs),
        });
      });
    }
  }

  files.sort(comparePaths);
  return { exceeded: false, files };
}
