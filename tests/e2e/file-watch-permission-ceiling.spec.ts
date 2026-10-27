/**
 * Real-Electron acceptance: a file-watch run keeps its own authority under a global 完全自主 mode.
 *
 * A watch rule (seeded in the isolated home's `.abu/watch-rules.json`) starts a background run
 * when a file appears in the watched folder. The run is pinned to the standard mode with the
 * scheduled ceiling, and nobody is present to answer, so a command the standard mode escalates is
 * refused: the folder the model asked to delete is still on disk, and the model is told the
 * command did not run. The model is the loopback mock; the watcher, the agent run, the permission
 * gate and the command tool are real.
 */
import { expect, test, type Frame } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type LaunchedApp,
} from './electronHelpers';
import { READY_TIMEOUT, startOpenAiMock, taskRequests, waitForApp, type OpenAiMock } from './openAiMock';

interface RequestMessage {
  content?: unknown;
  role?: unknown;
  tool_call_id?: unknown;
  tool_calls?: Array<{ id?: unknown; function?: { arguments?: unknown; name?: unknown } }>;
}

/** The result the model received for the last `run_command` call in a request body. */
function commandResult(body: unknown): { command: unknown; result: string } {
  const messages = (body as { messages?: RequestMessage[] } | null)?.messages ?? [];
  const call = messages
    .filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    .flatMap((message) => message.tool_calls ?? [])
    .filter((candidate) => candidate.function?.name === 'run_command')
    .at(-1);
  expect(call, 'the run continued from a run_command call').toBeDefined();
  const args = JSON.parse(String(call?.function?.arguments ?? '{}')) as { command?: unknown };
  const result = messages.find((message) => message.role === 'tool' && message.tool_call_id === call?.id);
  expect(result, 'the command\'s result is keyed to that call').toBeDefined();
  return { command: args.command, result: String(result?.content ?? '') };
}

test('a file-watch run under a global 完全自主 mode refuses a risky command instead of running it', async () => {
  test.setTimeout(180_000);
  const dataRoot = createElectronDataRoot();
  const watched = path.join(dataRoot.rootDir, 'watched-inbox');
  const processed = path.join(watched, 'processed');
  fs.mkdirSync(processed, { recursive: true });
  fs.writeFileSync(path.join(processed, 'keep.txt'), 'keep\n');
  // The isolated home of the run (electron/main.cjs: <appDataDir>/Home).
  const rulesDir = path.join(dataRoot.appDataDir, 'Home', '.abu');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'watch-rules.json'), JSON.stringify([{
    id: 'e2e-watch-rule',
    path: watched,
    pattern: '*.txt',
    event: 'create',
    prompt: 'A new file arrived: {fileName}. Tidy up the folder.',
    enabled: true,
  }]));

  const command = `rm -rf "${processed}"`;
  let mock: OpenAiMock | undefined;
  let launched: LaunchedApp | undefined;
  try {
    mock = await startOpenAiMock([
      // The watched folder is the run's authorized directory: with it as the working directory
      // the command reaches the mode's decision (without one it is refused earlier, whatever the mode).
      { kind: 'tool-call', toolName: 'run_command', toolCallId: `call-watch-${randomUUID()}`, arguments: { command, cwd: watched } },
      { kind: 'complete', responseText: 'The folder was left as it is.' },
    ]);
    launched = await launchAbuElectron(dataRoot);
    const page = await launched.app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    // The global mode the run must not follow.
    let configuredDocument = false;
    const onNavigation = (frame: Frame) => {
      if (frame === page.mainFrame()) configuredDocument = true;
    };
    page.on('framenavigated', onNavigation);
    try {
      await Promise.all([
        page.waitForEvent('console', {
          predicate: (message) => configuredDocument
            && message.text() === `[FileWatcher] Started watching: ${watched} (rule: e2e-watch-rule)`,
          timeout: READY_TIMEOUT,
        }),
        configureLocalMockProvider(page, mock.baseUrl, { permissionMode: 'autonomous', supportsTools: true }),
      ]);
    } finally {
      page.off('framenavigated', onNavigation);
    }

    fs.writeFileSync(path.join(watched, `arrival-${randomUUID().slice(0, 8)}.txt`), 'new\n');

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBeGreaterThanOrEqual(2);
    const { command: answeredCommand, result } = commandResult(taskRequests(mock)[1].body);
    expect(answeredCommand).toBe(command);
    // Refused before it ran: the folder and its file are still there.
    expect(fs.existsSync(path.join(processed, 'keep.txt'))).toBe(true);
    // By the standard mode asking a confirmation that nobody gives. Under 完全自主 the command
    // would have run; a refusal for want of a working directory would say so instead.
    expect(result).toMatch(/\[用户取消了此操作\]|\[User cancelled this operation\]/);
    expect(result).not.toMatch(/没有可写授权工作目录|no write-authorized working directory/);
  } finally {
    if (launched) await closeAbuElectron(launched.app);
    if (mock) await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});
