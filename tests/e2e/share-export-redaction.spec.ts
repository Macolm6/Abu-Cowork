/**
 * Real-Electron acceptance for what a shared conversation file carries: a
 * credential that a step's result printed is redacted everywhere in the file,
 * the step snapshot a reopened conversation shows included.
 *
 * A loopback model runs one command that prints a fake key. The conversation
 * is then exported from its sidebar menu. The system Save dialog is the one
 * thing replaced: the main process's `dialog.showSaveDialog` answers with a
 * path in the test's own data root, and everything else — building the
 * bundle, the export window, writing the file — runs as it does for a user.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
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
  waitForApp,
  type MockReplyPlan,
} from './openAiMock';
import { persistedStoreVersion } from './storeVersions';

const PROJECT_NAME = 'E2E 分享导出';
const PROMPT = '请读取密钥';
const FINAL_TEXT = '读完了。';
const FAKE_KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz123456';
const REPLY_TIMEOUT = 60_000;

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: { close: () => Promise<void> } | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

async function launchInProject(plans: MockReplyPlan[]): Promise<Page> {
  const root = createElectronDataRoot();
  dataRoot = root;
  const workspace = path.join(root.rootDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const startedMock = await startOpenAiMock(plans);
  mock = startedMock;

  app = (await launchAbuElectron(root)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.evaluate(({ name, workspacePath, version }) => {
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: {
        projects: {
          'project-share': {
            id: 'project-share', name, workspacePath, pinned: false, archived: false,
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
  return page;
}

/** Point the system Save dialog at `filePath`, the way a user picking that file would. */
async function answerSaveDialogWith(filePath: string): Promise<void> {
  await app!.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

test('an exported conversation redacts a key a step printed, in the step snapshot as in the tool call', async () => {
  test.setTimeout(180_000);
  const page = await launchInProject([
    { kind: 'tool-call', toolCallId: 'call-key', toolName: 'run_command', arguments: { command: `echo ${FAKE_KEY}` } },
    { kind: 'complete', responseText: FINAL_TEXT },
  ]);

  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(PROMPT);
  await composer.press('Enter');
  await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ }).last()).toBeVisible({ timeout: REPLY_TIMEOUT });

  // Sending the first message from a new task folds the sidebar away.
  const showSidebar = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  const row = page.getByRole('button', { name: new RegExp(`^${PROMPT}`) });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '导出会话', exact: true }).click();

  const exportWindow = page.getByRole('dialog', { name: '导出对话 · 预览' });
  await expect(exportWindow).toBeVisible();
  await expect(exportWindow.getByText(/^共 \d+ 处$/)).toBeVisible({ timeout: READY_TIMEOUT });

  const target = path.join(dataRoot!.rootDir, 'shared.json');
  await answerSaveDialogWith(target);
  await exportWindow.getByRole('button', { name: '导出', exact: true }).click();
  await expect.poll(() => fs.existsSync(target), { timeout: READY_TIMEOUT }).toBe(true);
  await expect(exportWindow).toBeHidden();

  const text = fs.readFileSync(target, 'utf8');
  const bundle = JSON.parse(text) as {
    messages: { executionSteps?: { toolName: string; detailBlocks?: { content?: string }[] }[] }[];
  };
  expect(text).not.toContain(FAKE_KEY);
  const step = bundle.messages
    .flatMap((message) => message.executionSteps ?? [])
    .find((candidate) => candidate.toolName === 'run_command');
  expect(step?.detailBlocks?.some((block) => block.content?.includes('[REDACTED:anthropic-key]'))).toBe(true);
});
