import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_LIST_MAX_DEPTH,
  WORKSPACE_LIST_MAX_ENTRIES,
  parseWorkspaceListLimits,
  walkWorkspaceFiles,
  type WorkspaceWalkIo,
} from './workspaceFileWalk';

type Node =
  | { kind: 'file'; size: number; mtimeMs: number | null }
  | { kind: 'dir' }
  | { kind: 'symlink' };

function file(size: number, mtimeMs: number | null = 1000): Node {
  return { kind: 'file', size, mtimeMs };
}

/** An in-memory tree keyed by absolute path; `io` records every directory it is asked to read. */
function tree(nodes: Record<string, Node>): { io: WorkspaceWalkIo; readDirs: string[]; stats: string[] } {
  const readDirs: string[] = [];
  const stats: string[] = [];
  const io: WorkspaceWalkIo = {
    readDir: async (path) => {
      readDirs.push(path);
      const prefix = `${path}/`;
      return Object.entries(nodes)
        .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map(([key, node]) => ({
          name: key.slice(prefix.length),
          isDirectory: node.kind === 'dir',
          isFile: node.kind === 'file',
          isSymlink: node.kind === 'symlink',
        }));
    },
    stat: async (path) => {
      stats.push(path);
      const node = nodes[path];
      if (!node || node.kind !== 'file') throw new Error(`not a file: ${path}`);
      return { size: node.size, mtimeMs: node.mtimeMs };
    },
  };
  return { io, readDirs, stats };
}

const LIMITS = { maxEntries: WORKSPACE_LIST_MAX_ENTRIES, maxDepth: WORKSPACE_LIST_MAX_DEPTH };

describe('walkWorkspaceFiles', () => {
  it('lists files with their relative path, size and modification time, sorted by path', async () => {
    const { io } = tree({
      '/ws/b.md': file(20, 2000),
      '/ws/a.md': file(10, 1000),
      '/ws/docs': { kind: 'dir' },
      '/ws/docs/plan.md': file(30, 3000),
    });

    await expect(walkWorkspaceFiles('/ws', LIMITS, io)).resolves.toEqual({
      exceeded: false,
      files: [
        { path: 'a.md', size: 10, mtimeMs: 1000 },
        { path: 'b.md', size: 20, mtimeMs: 2000 },
        { path: 'docs/plan.md', size: 30, mtimeMs: 3000 },
      ],
    });
  });

  it('reads a root given with a trailing separator or backslashes', async () => {
    const { io } = tree({ '/ws/a.md': file(1) });
    const result = await walkWorkspaceFiles('\\ws\\', LIMITS, io);
    expect(result).toEqual({ exceeded: false, files: [{ path: 'a.md', size: 1, mtimeMs: 1000 }] });
  });

  it('truncates a fractional modification time to whole milliseconds', async () => {
    const { io } = tree({ '/ws/a.md': file(1, 1234.9) });
    const result = await walkWorkspaceFiles('/ws', LIMITS, io);
    expect(result).toEqual({ exceeded: false, files: [{ path: 'a.md', size: 1, mtimeMs: 1234 }] });
  });

  it.each([
    '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache', 'target', '.hidden',
  ])('does not enter the directory %s', async (name) => {
    const { io, readDirs } = tree({
      '/ws/keep.md': file(1),
      [`/ws/${name}`]: { kind: 'dir' },
      [`/ws/${name}/inside.md`]: file(1),
    });

    const result = await walkWorkspaceFiles('/ws', LIMITS, io);

    expect(result).toEqual({ exceeded: false, files: [{ path: 'keep.md', size: 1, mtimeMs: 1000 }] });
    expect(readDirs).toEqual(['/ws']);
  });

  it('skips a skipped name below the root as well', async () => {
    const { io } = tree({
      '/ws/app': { kind: 'dir' },
      '/ws/app/node_modules': { kind: 'dir' },
      '/ws/app/node_modules/x.js': file(1),
      '/ws/app/main.ts': file(1),
    });
    const result = await walkWorkspaceFiles('/ws', LIMITS, io);
    expect(result).toEqual({ exceeded: false, files: [{ path: 'app/main.ts', size: 1, mtimeMs: 1000 }] });
  });

  it('lists a dot file and leaves .DS_Store out', async () => {
    const { io } = tree({ '/ws/.env': file(1), '/ws/.DS_Store': file(1) });
    const result = await walkWorkspaceFiles('/ws', LIMITS, io);
    expect(result).toEqual({ exceeded: false, files: [{ path: '.env', size: 1, mtimeMs: 1000 }] });
  });

  it('neither lists nor follows a symbolic link', async () => {
    const { io, readDirs, stats } = tree({
      '/ws/real.md': file(1),
      '/ws/link.md': { kind: 'symlink' },
      '/ws/linked-dir': { kind: 'symlink' },
      '/ws/linked-dir/inside.md': file(1),
    });

    const result = await walkWorkspaceFiles('/ws', LIMITS, io);

    expect(result).toEqual({ exceeded: false, files: [{ path: 'real.md', size: 1, mtimeMs: 1000 }] });
    expect(readDirs).toEqual(['/ws']);
    expect(stats).toEqual(['/ws/real.md']);
  });

  it('lists the files of a directory at the depth limit and does not enter the directories below it', async () => {
    const { io, readDirs } = tree({
      '/ws/top.md': file(1),
      '/ws/d1': { kind: 'dir' },
      '/ws/d1/one.md': file(1),
      '/ws/d1/d2': { kind: 'dir' },
      '/ws/d1/d2/two.md': file(1),
      '/ws/d1/d2/d3': { kind: 'dir' },
      '/ws/d1/d2/d3/three.md': file(1),
    });

    const result = await walkWorkspaceFiles('/ws', { maxEntries: 100, maxDepth: 2 }, io);

    expect(result).toEqual({
      exceeded: false,
      files: [
        { path: 'd1/d2/two.md', size: 1, mtimeMs: 1000 },
        { path: 'd1/one.md', size: 1, mtimeMs: 1000 },
        { path: 'top.md', size: 1, mtimeMs: 1000 },
      ],
    });
    expect(readDirs).toEqual(['/ws', '/ws/d1', '/ws/d1/d2']);
  });

  it('returns the files when their count equals the entry limit', async () => {
    const { io } = tree({ '/ws/a.md': file(1), '/ws/b.md': file(1), '/ws/c.md': file(1) });
    const result = await walkWorkspaceFiles('/ws', { maxEntries: 3, maxDepth: 12 }, io);
    expect(result.exceeded).toBe(false);
  });

  it('reports exceeded, with no files, once the count passes the entry limit', async () => {
    const { io, stats } = tree({
      '/ws/a.md': file(1),
      '/ws/b.md': file(1),
      '/ws/sub': { kind: 'dir' },
      '/ws/sub/c.md': file(1),
      '/ws/sub/d.md': file(1),
    });

    const result = await walkWorkspaceFiles('/ws', { maxEntries: 3, maxDepth: 12 }, io);

    expect(result).toEqual({ exceeded: true });
    expect(stats.length).toBeLessThanOrEqual(3);
  });
});

describe('parseWorkspaceListLimits', () => {
  it('uses the defaults when no limit is given', () => {
    expect(parseWorkspaceListLimits(undefined)).toEqual(LIMITS);
    expect(parseWorkspaceListLimits({})).toEqual(LIMITS);
  });

  it('accepts limits at or under the defaults', () => {
    expect(parseWorkspaceListLimits({ maxEntries: 5, maxDepth: 1 })).toEqual({ maxEntries: 5, maxDepth: 1 });
    expect(parseWorkspaceListLimits({ maxEntries: 20000, maxDepth: 12 })).toEqual(LIMITS);
  });

  it.each([
    [{ maxEntries: 20001 }],
    [{ maxDepth: 13 }],
    [{ maxEntries: 0 }],
    [{ maxDepth: -1 }],
    [{ maxEntries: 1.5 }],
    [{ maxEntries: '10' }],
    [{ maxDepth: null }],
    ['limits'],
    [[1, 2]],
  ])('returns null for %j', (value) => {
    expect(parseWorkspaceListLimits(value)).toBeNull();
  });
});
