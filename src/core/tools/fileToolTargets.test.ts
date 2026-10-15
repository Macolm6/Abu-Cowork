import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planToolFiles, resolveToolFileInput, hasToolFileTargets } from './fileToolTargets';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { homeDir } from '@tauri-apps/api/path';

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn().mockResolvedValue('/Users/testuser'),
  downloadDir: vi.fn().mockResolvedValue('/Users/testuser/Downloads'),
}));

const workspace = useWorkspaceStore.getState().currentPath;
beforeEach(() => {
  vi.mocked(homeDir).mockResolvedValue('/Users/testuser');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
  useWorkspaceStore.setState({ currentPath: null });
});
afterEach(() => {
  vi.useRealTimers();
  useWorkspaceStore.setState({ currentPath: workspace });
});

describe('declared tool file targets', () => {
  it('normalizes the full path and preserves every input field in a frozen request', async () => {
    const content = `${'padding '.repeat(100)}complete content`;
    const input = { path: ' ./reports/../report.txt ', content, options: { values: ['original'] } };
    const plan = await planToolFiles('write_file', input, { workspacePath: '/work' });
    expect(plan?.input).toEqual({ ...input, path: '/work/report.txt' });
    expect(plan?.targets).toEqual([
      { inputPath: './reports/../report.txt', path: '/work/report.txt', purpose: 'write', followFinalSymlink: true },
      { inputPath: './reports/../report.txt', path: '/work/report.txt', purpose: 'read', followFinalSymlink: true },
    ]);
    input.options.values.push('changed');
    expect(plan?.input.options).toEqual({ values: ['original'] });
    expect(Object.isFrozen(plan?.input)).toBe(true);
    expect(Object.isFrozen(plan?.targets)).toBe(true);
  });

  it.each([
    ['~', '/Users/testuser'],
    ['~/reports/../report.txt', '/Users/testuser/report.txt'],
    ['~\\report.txt', '/Users/testuser/report.txt'],
    ['C:\\work\\reports\\..\\report.txt', 'C:/work/report.txt'],
  ])('expands %s to its complete lexical target', async (input, path) => {
    const plan = await planToolFiles('read_file', { path: input });
    expect(plan?.targets[0].path).toBe(path);
  });

  it('keeps delete entry semantics for both deletion and a recorded before-side', async () => {
    const plan = await planToolFiles('delete_file', { path: '/work/link' }, { loopId: 'recorded-turn' });
    expect(plan?.targets.map(target => [target.purpose, target.followFinalSymlink])).toEqual([
      ['delete', false], ['read', false],
    ]);
  });

  it('plans all presented targets and resolves only declared file arguments', async () => {
    const input = { files: [{ path: 'a.txt', description: 'A' }, { path: 'b.txt' }], label: 'a.txt' };
    const plan = await planToolFiles('present_files', input, { workspacePath: '/work' });
    expect(plan?.targets.map(target => target.path)).toEqual(['/work/a.txt', '/work/b.txt']);
    const resolved = resolveToolFileInput('present_files', plan!.input, new Map([
      ['/work/a.txt', '/canonical/a.txt'], ['/work/b.txt', '/canonical/b.txt'], ['a.txt', 'unrelated'],
    ]));
    expect(resolved).toEqual({ files: [{ path: '/canonical/a.txt', description: 'A' }, { path: '/canonical/b.txt' }], label: 'a.txt' });
    expect(input.files[0].path).toBe('a.txt');
  });

  it('plans image input and output independently and retains processing parameters', async () => {
    const plan = await planToolFiles('process_image', { input_path: 'source.png', output_path: 'result.png', operation: 'resize', params: { width: 2 } }, { workspacePath: '/work' });
    expect(plan?.targets.map(target => [target.path, target.purpose])).toEqual([['/work/source.png', 'read'], ['/work/result.png', 'write']]);
    expect(resolveToolFileInput('process_image', plan!.input, new Map([['/work/source.png', '/source.png'], ['/work/result.png', '/result.png']]))).toEqual({
      input_path: '/source.png', output_path: '/result.png', operation: 'resize', params: { width: 2 },
    });
  });

  it('chooses a generated image destination before later work and resolves explicit destinations', async () => {
    const generated = await planToolFiles('generate_image', { prompt: 'image' });
    expect(generated?.targets[0].path).toBe('/Users/testuser/Downloads/abu-image-1791936000000.png');
    const explicit = await planToolFiles('generate_image', { save_path: 'output.png' }, { workspacePath: '/work' });
    expect(resolveToolFileInput('generate_image', explicit!.input, new Map([['/work/output.png', '/canonical/output.png']])).save_path).toBe('/canonical/output.png');
  });

  it('keeps a generated destination fixed while the path boundary waits and the visible workspace changes', async () => {
    let resolveHome!: (home: string) => void;
    vi.mocked(homeDir).mockReturnValueOnce(new Promise(resolve => { resolveHome = resolve; }));
    useWorkspaceStore.setState({ currentPath: '/original-work' });
    const pending = planToolFiles('generate_image', { prompt: 'image' });
    useWorkspaceStore.setState({ currentPath: '/other-work' });
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    resolveHome('/Users/testuser');
    const plan = await pending;
    expect(plan?.targets[0].path).toBe('/original-work/abu-image-1791936000000.png');
    expect(plan?.workspacePath).toBe('/original-work');
  });

  it.each([false, true])('preserves browser upload transport shape when files are encoded=%s', async encoded => {
    const files = [{ path: 'first.txt' }, { path: 'second.txt' }];
    const input = { files: encoded ? JSON.stringify(files) : files };
    const name = 'abu-browser__upload_file';
    const plan = await planToolFiles(name, input, { workspacePath: '/work' });
    expect(plan?.targets.map(target => [target.path, target.followFinalSymlink])).toEqual([['/work/first.txt', false], ['/work/second.txt', false]]);
    const expected = [{ path: '/canonical/first.txt' }, { path: '/canonical/second.txt' }];
    const resolved = resolveToolFileInput(name, plan!.input, new Map([['/work/first.txt', expected[0].path], ['/work/second.txt', expected[1].path]]));
    expect(resolved.files).toEqual(encoded ? JSON.stringify(expected) : expected);
  });

  it('leaves malformed targets for tool validation and leaves other tools without a file plan', async () => {
    expect(await planToolFiles('read_file', { path: '  ' })).toMatchObject({ targets: [] });
    expect(await planToolFiles('abu-browser__upload_file', { files: 'invalid' })).toMatchObject({ targets: [] });
    expect(await planToolFiles('run_command', { command: 'echo test' })).toBeNull();
    expect(hasToolFileTargets('run_command')).toBe(false);
    expect(resolveToolFileInput('read_file', { path: '/work/a.txt', note: '/work/a.txt' }, new Map([['/work/a.txt', '/canonical/a.txt']]))).toEqual({ path: '/canonical/a.txt', note: '/work/a.txt' });
  });
});
