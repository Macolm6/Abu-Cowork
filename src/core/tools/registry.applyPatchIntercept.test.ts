// A model trained on apply_patch may run it as a shell command, the way Codex
// lets it (`apply_patch <<'EOF' … EOF`). While apply_patch is offered to the
// run, the registry turns that command into an apply_patch call; the shell
// never sees it. These cases drive the real executeAnyTool.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';
import { useChatStore } from '../../stores/chatStore';
import { executeAnyTool } from './registry';
import { registerBuiltinTools } from './builtins';
import { setToolAuthorizationProvider } from './operationAuthorization';
import { authorizeWorkspace, revokeWorkspace } from './pathSafety';
import { TOOL_NAMES } from './toolNames';

vi.mock('@/utils/aiEditSnapshots', () => ({
  captureTurnFileBefore: vi.fn().mockResolvedValue(undefined),
  snapshotBeforeAiEdit: vi.fn().mockResolvedValue(undefined),
}));

const WORKSPACE = '/Users/testuser/work';
const FILE = `${WORKSPACE}/a.txt`;
// Without a host authorization provider no planner resolves relative paths,
// so the patch names its file the way the path check wants it: absolute.
const PATCH = `*** Begin Patch\n*** Update File: ${FILE}\n@@\n-a\n+b\n*** End Patch`;
const COMMAND = `apply_patch <<'EOF'\n${PATCH}\nEOF`;

function shellCalls(): string[] {
  return vi.mocked(invoke).mock.calls
    .filter(([cmd]) => cmd === 'run_shell_command')
    .map(([, payload]) => String((payload as { command: string }).command));
}

describe('run_command → apply_patch interception', () => {
  beforeEach(() => {
    registerBuiltinTools();
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    setMigratedBrowserSettings({ permissionMode: 'autonomous' });
    setToolAuthorizationProvider(null);
    authorizeWorkspace(WORKSPACE, ['read', 'write']);
    vi.mocked(invoke).mockReset().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    vi.mocked(exists).mockReset().mockImplementation(async (p) => p === FILE);
    vi.mocked(readTextFile).mockReset().mockResolvedValue('a\n');
    vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    revokeWorkspace(WORKSPACE);
  });

  it('applies the patch through the patch tool when apply_patch is offered, and runs no shell', async () => {
    const result = await executeAnyTool(TOOL_NAMES.RUN_COMMAND, { command: COMMAND }, undefined, undefined, {
      conversationId: 'conv-1', workspacePath: WORKSPACE, offeredToolNames: [TOOL_NAMES.RUN_COMMAND, TOOL_NAMES.APPLY_PATCH],
    });
    expect(result).toBe(`Patch applied:\nUpdated ${FILE} (+1 −1)`);
    expect(writeTextFile).toHaveBeenCalledWith(FILE, 'b\n');
    expect(shellCalls()).toEqual([]);
  });

  it('hands the same command to the shell when apply_patch is not offered (the replace style)', async () => {
    await executeAnyTool(TOOL_NAMES.RUN_COMMAND, { command: COMMAND }, undefined, undefined, {
      conversationId: 'conv-1', workspacePath: WORKSPACE, offeredToolNames: [TOOL_NAMES.RUN_COMMAND, TOOL_NAMES.EDIT_FILE],
    });
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(shellCalls()).toEqual([COMMAND]);
  });

  it('leaves an ordinary command on the shell even while apply_patch is offered', async () => {
    await executeAnyTool(TOOL_NAMES.RUN_COMMAND, { command: 'git status' }, undefined, undefined, {
      conversationId: 'conv-1', workspacePath: WORKSPACE, offeredToolNames: [TOOL_NAMES.RUN_COMMAND, TOOL_NAMES.APPLY_PATCH],
    });
    expect(shellCalls()).toEqual(['git status']);
  });

  it('reports a patch that does not match as the patch tool does, without running a shell', async () => {
    vi.mocked(readTextFile).mockResolvedValue('something else\n');
    const result = await executeAnyTool(TOOL_NAMES.RUN_COMMAND, { command: COMMAND }, undefined, undefined, {
      conversationId: 'conv-1', workspacePath: WORKSPACE, offeredToolNames: [TOOL_NAMES.APPLY_PATCH],
    });
    expect(result).toContain(`Error: the hunk does not match ${FILE}`);
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(shellCalls()).toEqual([]);
  });
});
