import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from '@/types';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { getI18n, format } from '@/i18n';
import { editFileTool, readFileTool, writeFileTool } from './fileTools';
import { applyPatchTool } from './patchTools';
import { forgetFileReads, recordFileVersion, recordedFileVersion } from '../fileReadRecords';

vi.mock('@/utils/aiEditSnapshots', () => ({
  captureTurnFileBefore: vi.fn().mockResolvedValue(undefined),
  snapshotBeforeAiEdit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../agent/defaultWorkspace', () => ({
  bindWorkspaceFromWrite: vi.fn().mockResolvedValue(undefined),
}));

/** An in-memory disk behind the host file access the tools are given. */
function memoryFiles(initial: Record<string, string>) {
  const disk = new Map(Object.entries(initial));
  const read = (path: string): string => {
    const text = disk.get(path);
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return text;
  };
  const files = {
    executionInput: {},
    originalPath: (path: string) => path,
    prepare: async () => {},
    assertCurrent: async () => {},
    assertActive: () => {},
    resultGuard: () => ({ assertCurrent: async () => {}, assertActive: () => {} }),
    exists: async (path: string) => disk.has(path),
    stat: async (path: string) => ({ isFile: true, isDirectory: false, isSymlink: false, size: read(path).length, mtime: null }),
    readTextFile: async (path: string) => read(path),
    readFile: async (path: string) => new TextEncoder().encode(read(path)),
    writeTextFile: async (path: string, text: string) => { disk.set(path, text); },
    ensureParentDir: async () => {},
    prepareDelete: async () => {},
    moveToTrash: async (path: string) => { disk.delete(path); },
    dispose: async () => {},
  } as unknown as ToolFileAccess;
  return { files, disk };
}

let conversationSeq = 0;
let conversationId = '';

beforeEach(() => {
  conversationSeq += 1;
  conversationId = `conv-${conversationSeq}`;
});

function ctx(files: ToolFileAccess, extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { files, workspacePath: '/work', loopId: 'loop-1', conversationId, ...extra };
}

const refusal = (path: string) => format(getI18n().toolResult.file.errWriteNeedsRead, { path });

describe('write_file — overwriting needs a read of the current version', () => {
  it('refuses to overwrite a file the agent has not read, and leaves it untouched', async () => {
    const { files, disk } = memoryFiles({ '/work/a.txt': 'user text' });
    const result = await writeFileTool.execute({ path: '/work/a.txt', content: 'model text' }, ctx(files));
    expect(result).toBe(refusal('/work/a.txt'));
    expect(disk.get('/work/a.txt')).toBe('user text');
  });

  it('overwrites a file the agent has read', async () => {
    const { files, disk } = memoryFiles({ '/work/a.txt': 'user text' });
    await readFileTool.execute({ path: '/work/a.txt' }, ctx(files));
    const result = await writeFileTool.execute({ path: '/work/a.txt', content: 'model text' }, ctx(files));
    expect(result).toBe('Successfully wrote 10 characters to /work/a.txt');
    expect(disk.get('/work/a.txt')).toBe('model text');
  });

  it('counts a read of only some lines as a read of the whole file', async () => {
    const { files, disk } = memoryFiles({ '/work/a.txt': 'one\ntwo\nthree' });
    await readFileTool.execute({ path: '/work/a.txt', offset: 1, limit: 1 }, ctx(files));
    await writeFileTool.execute({ path: '/work/a.txt', content: 'new' }, ctx(files));
    expect(disk.get('/work/a.txt')).toBe('new');
  });

  it('refuses when the file changed after the read, and overwrites the latest content once read again', async () => {
    const { files, disk } = memoryFiles({ '/work/a.txt': 'v1' });
    await readFileTool.execute({ path: '/work/a.txt' }, ctx(files));
    disk.set('/work/a.txt', 'v2 edited by the user');

    expect(await writeFileTool.execute({ path: '/work/a.txt', content: 'model' }, ctx(files))).toBe(refusal('/work/a.txt'));
    expect(disk.get('/work/a.txt')).toBe('v2 edited by the user');

    expect(await readFileTool.execute({ path: '/work/a.txt' }, ctx(files))).toBe('v2 edited by the user');
    await writeFileTool.execute({ path: '/work/a.txt', content: 'model' }, ctx(files));
    expect(disk.get('/work/a.txt')).toBe('model');
  });

  it('does not let one expert overwrite a file only another expert has read', async () => {
    const { files, disk } = memoryFiles({ '/work/a.txt': 'shared' });
    await readFileTool.execute({ path: '/work/a.txt' }, ctx(files, { agentRunId: 'sar-a' }));

    const result = await writeFileTool.execute({ path: '/work/a.txt', content: 'b' }, ctx(files, { agentRunId: 'sar-b' }));
    expect(result).toBe(refusal('/work/a.txt'));
    expect(disk.get('/work/a.txt')).toBe('shared');
  });

  it('does not let a subagent overwrite a file only the conversation agent has read', async () => {
    const { files } = memoryFiles({ '/work/a.txt': 'shared' });
    await readFileTool.execute({ path: '/work/a.txt' }, ctx(files));
    const result = await writeFileTool.execute({ path: '/work/a.txt', content: 'x' }, ctx(files, { agentRunId: 'sar-a' }));
    expect(result).toBe(refusal('/work/a.txt'));
  });

  it('keeps the conversation agent\'s reads across its turns', async () => {
    const { files, disk } = memoryFiles({ '/work/a.txt': 'old' });
    await readFileTool.execute({ path: '/work/a.txt' }, ctx(files, { loopId: 'turn-1' }));
    await writeFileTool.execute({ path: '/work/a.txt', content: 'new' }, ctx(files, { loopId: 'turn-2' }));
    expect(disk.get('/work/a.txt')).toBe('new');
  });

  it('creates a new file without a read', async () => {
    const { files, disk } = memoryFiles({});
    const result = await writeFileTool.execute({ path: '/work/new.txt', content: 'hello' }, ctx(files));
    expect(result).toBe('Successfully wrote 5 characters to /work/new.txt');
    expect(disk.get('/work/new.txt')).toBe('hello');
  });

  it('overwrites a file it wrote itself without reading it again', async () => {
    const { files, disk } = memoryFiles({});
    await writeFileTool.execute({ path: '/work/report.csv', content: 'a,b' }, ctx(files));
    await writeFileTool.execute({ path: '/work/report.csv', content: 'c,d' }, ctx(files));
    expect(disk.get('/work/report.csv')).toBe(`${String.fromCharCode(0xfeff)}c,d`);
  });

  it('overwrites a file after edit_file changed it', async () => {
    const { files, disk } = memoryFiles({ '/work/a.txt': 'hello world' });
    await editFileTool.execute({ path: '/work/a.txt', old_content: 'world', new_content: 'there' }, ctx(files));
    await writeFileTool.execute({ path: '/work/a.txt', content: 'rewritten' }, ctx(files));
    expect(disk.get('/work/a.txt')).toBe('rewritten');
  });

  it('refuses a file that was absent when read and has been created since', async () => {
    const { files, disk } = memoryFiles({});
    expect(await readFileTool.execute({ path: '/work/a.txt' }, ctx(files))).toBe('Error reading file: File not found: /work/a.txt');
    disk.set('/work/a.txt', 'created by the user');

    expect(await writeFileTool.execute({ path: '/work/a.txt', content: 'x' }, ctx(files))).toBe(refusal('/work/a.txt'));
    expect(disk.get('/work/a.txt')).toBe('created by the user');
  });

  it('overwrites a file after apply_patch wrote it', async () => {
    const { files, disk } = memoryFiles({ '/work/a.txt': 'one\ntwo\n' });
    await applyPatchTool.execute({
      input: '*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n*** End Patch',
      operations: [{ type: 'update', path: '/work/a.txt' }],
    }, ctx(files));
    expect(disk.get('/work/a.txt')).toBe('one\nTWO\n');

    await writeFileTool.execute({ path: '/work/a.txt', content: 'whole' }, ctx(files));
    expect(disk.get('/work/a.txt')).toBe('whole');
  });

  it('overwrites a file apply_patch added', async () => {
    const { files, disk } = memoryFiles({});
    await applyPatchTool.execute({
      input: '*** Begin Patch\n*** Add File: b.txt\n+added\n*** End Patch',
      operations: [{ type: 'add', path: '/work/b.txt' }],
    }, ctx(files));
    await writeFileTool.execute({ path: '/work/b.txt', content: 'whole' }, ctx(files));
    expect(disk.get('/work/b.txt')).toBe('whole');
  });

  it('refuses a write outside any conversation, where no read can have happened', async () => {
    const { files } = memoryFiles({ '/work/a.txt': 'x' });
    await readFileTool.execute({ path: '/work/a.txt' }, { files });
    expect(await writeFileTool.execute({ path: '/work/a.txt', content: 'y' }, { files })).toBe(refusal('/work/a.txt'));
  });
});

describe('fileReadRecords', () => {
  it('finds the reads of a nested subagent whether its call carries agentRunId or fileReadRunId', async () => {
    await recordFileVersion('/work/a.txt', 'abc', { conversationId, agentRunId: 'sar-n' });
    expect(await recordedFileVersion('/work/a.txt', { conversationId, fileReadRunId: 'sar-n' })).toBe('abc');
    expect(await recordedFileVersion('/work/a.txt', { conversationId })).toBeUndefined();
  });

  it('keys a path by its normalized form', async () => {
    await recordFileVersion('C:\\work\\a.txt', 'abc', { conversationId });
    expect(await recordedFileVersion('C:/work/a.txt', { conversationId })).toBe('abc');
  });

  it('drops a finished run\'s records and keeps the conversation agent\'s', async () => {
    await recordFileVersion('/work/a.txt', 'run', { conversationId, agentRunId: 'sar-a' });
    await recordFileVersion('/work/a.txt', 'main', { conversationId });
    forgetFileReads(conversationId, 'sar-a');
    expect(await recordedFileVersion('/work/a.txt', { conversationId, agentRunId: 'sar-a' })).toBeUndefined();
    expect(await recordedFileVersion('/work/a.txt', { conversationId })).toBe('main');
  });
});
