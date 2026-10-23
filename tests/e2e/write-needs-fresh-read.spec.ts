/**
 * Real-Electron acceptance for write_file overwriting only a file the agent
 * has read in its current version.
 *
 * A loopback model scripts each turn. The first write_file over an existing
 * file the model has not read, or that changed after its read, writes nothing
 * and its step shows the failure; after a read_file the same write goes
 * through and the disk holds the model's text. The read runs in the sidecar
 * and the records live in the shell, so these cases cross that boundary.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  startOpenAiMock,
  taskRequests,
  waitForApp,
  type MockReplyPlan,
  type OpenAiMock,
} from './openAiMock';
import { persistedStoreVersion } from './storeVersions';

const PROJECT_NAME = 'E2E 先读再写';
const FILE_NAME = '方案.md';
const USER_TEXT = '# 方案\n用户手动改过的内容\n';
const MODEL_TEXT = '# 方案\n阿布重写的内容\n';
const FINAL_TEXT = '已经重写好了。';
const REPLY_TIMEOUT = 60_000;
const REFUSAL = /没有写入|was not written/;

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

function toolCall(id: string, toolName: string, args: Record<string, unknown>): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName, arguments: args };
}

function finalReply(text: string): MockReplyPlan {
  return { kind: 'complete', responseText: text };
}

/** Launch the app with a project whose folder holds `FILE_NAME`, and a new task open in that project. */
async function launchInProject(plansFor: (filePath: string) => MockReplyPlan[]): Promise<{ page: Page; filePath: string }> {
  const root = createElectronDataRoot();
  dataRoot = root;
  const workspace = path.join(root.rootDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const filePath = path.join(workspace, FILE_NAME);
  fs.writeFileSync(filePath, USER_TEXT);
  const startedMock = await startOpenAiMock(plansFor(filePath));
  mock = startedMock;

  app = (await launchAbuElectron(root)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.evaluate(({ name, workspacePath, version }) => {
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: {
        projects: {
          'project-fresh-read': {
            id: 'project-fresh-read', name, workspacePath, pinned: false, archived: false,
            createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, lastActiveAt: 1_800_000_000_000,
          },
        },
      },
      version,
    }));
  }, { name: PROJECT_NAME, workspacePath: workspace, version: persistedStoreVersion('abu-projects') });
  await dismissFirstRunOverlays(page);
  await configureLocalMockProvider(page, startedMock.baseUrl, { supportsTools: true, permissionMode: 'standard' });

  await page.getByRole('button', { name: PROJECT_NAME, exact: true })
    .locator('xpath=..')
    .getByRole('button', { name: '新任务', exact: true })
    .click();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible();
  return { page, filePath };
}

/**
 * Send a prompt and wait until its turn has ended: the reply is there and the
 * conversation shows `turn` folded work processes, this turn's among them.
 */
async function runTurn(page: Page, prompt: string, finalText: string, turn: number): Promise<void> {
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(prompt);
  await composer.press('Enter');
  await expect(page.getByText(finalText)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ })).toHaveCount(turn, { timeout: REPLY_TIMEOUT });
}

interface SentMessage {
  role?: string;
  tool_call_id?: string;
  content?: unknown;
}

/**
 * The tool results the model was handed back, in call order, as the last
 * request carries the conversation. The request names tool calls by their
 * position in it, so the results are matched by order.
 */
function toolResultsSent(): string[] {
  const last = taskRequests(mock!).at(-1);
  const messages = (last?.body as { messages?: SentMessage[] } | undefined)?.messages ?? [];
  return messages.filter((message) => message.role === 'tool').map((message) => String(message.content ?? ''));
}

/**
 * Wait until no animation runs on `target` or an element around it. Rows keep
 * moving for a moment after a turn ends or a block unfolds, and a press that
 * starts on a moving control ends on another element and does nothing.
 */
async function waitUntilAtRest(target: Locator): Promise<void> {
  await expect.poll(() => target.evaluate((element) => document.getAnimations()
    .filter((animation) => (animation.effect as KeyframeEffect | null)?.target?.contains(element))
    .length)).toBe(0);
}

/** Press `button` once it has stopped moving, unless it is already expanded. */
async function expand(button: Locator): Promise<void> {
  await expect(button).toBeVisible();
  await waitUntilAtRest(button);
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
}

/** Unfold the last turn's work process and its group of steps, so every step row is on the page. */
async function showLastTurnSteps(page: Page): Promise<void> {
  await expand(page.getByRole('button', { name: /^用时/ }).last());
  await expand(page.getByRole('button', { name: /^(修改了|创建了|读取了|执行了|调用了)/ }).last());
}

/**
 * The turn's steps show the refused write as one failed step, whose 错误 block
 * holds the refusal, and the turn's card lists the file as edited.
 */
async function expectOneFailedWriteStep(page: Page): Promise<void> {
  await showLastTurnSteps(page);
  const errorBlock = page.getByRole('button', { name: '错误', exact: true });
  await expect(errorBlock).toHaveCount(1);
  await expand(errorBlock);
  const failure: Locator = page.locator('[data-tool-result]').filter({ hasText: REFUSAL });
  await expect(failure).toHaveCount(1);
  await expect(failure).toHaveClass(/\btext-danger\b/);
  await expect(page.getByRole('button', { name: `已编辑 ${FILE_NAME} +1 −1`, exact: true })).toBeVisible();
}

test('the first overwrite of a file the model has not read fails, and after read_file the write goes through', async () => {
  test.setTimeout(180_000);
  const { page, filePath } = await launchInProject((target) => [
    toolCall('call-write-unread', 'write_file', { path: target, content: MODEL_TEXT }),
    toolCall('call-read', 'read_file', { path: target }),
    toolCall('call-write-read', 'write_file', { path: target, content: MODEL_TEXT }),
    finalReply(FINAL_TEXT),
  ]);

  await runTurn(page, '请重写方案', FINAL_TEXT, 1);

  const [unreadWrite, read, writeAfterRead, ...rest] = toolResultsSent();
  expect(unreadWrite).toMatch(REFUSAL);
  expect(read).toBe(USER_TEXT);
  expect(writeAfterRead).toMatch(/Successfully wrote/);
  expect(rest).toEqual([]);
  expect(fs.readFileSync(filePath, 'utf8')).toBe(MODEL_TEXT);

  await expectOneFailedWriteStep(page);
});

test('a file the user changed after the model read it is not overwritten until the model reads it again', async () => {
  test.setTimeout(240_000);
  const { page, filePath } = await launchInProject((target) => [
    toolCall('call-read-first', 'read_file', { path: target }),
    finalReply('已经看过了。'),
    toolCall('call-write-stale', 'write_file', { path: target, content: MODEL_TEXT }),
    toolCall('call-read-again', 'read_file', { path: target }),
    toolCall('call-write-fresh', 'write_file', { path: target, content: MODEL_TEXT }),
    finalReply(FINAL_TEXT),
  ]);

  await runTurn(page, '先看看方案', '已经看过了。', 1);
  const userEdit = '# 方案\n用户在两轮之间又改了一处\n';
  fs.writeFileSync(filePath, userEdit);

  await runTurn(page, '请重写方案', FINAL_TEXT, 2);

  const [firstRead, staleWrite, readAgain, freshWrite, ...rest] = toolResultsSent();
  expect(firstRead).toBe(USER_TEXT);
  expect(staleWrite).toMatch(REFUSAL);
  expect(readAgain).toBe(userEdit);
  expect(freshWrite).toMatch(/Successfully wrote/);
  expect(rest).toEqual([]);
  expect(fs.readFileSync(filePath, 'utf8')).toBe(MODEL_TEXT);

  await expectOneFailedWriteStep(page);
});
