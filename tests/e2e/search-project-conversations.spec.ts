/**
 * Real-Electron acceptance for the conversation search: a conversation of a
 * project is found by its title, by its project's name and by a passage of its
 * messages; its result names the project; and opening it expands the project in
 * the sidebar and brings its row into view.
 *
 * Deterministic per TESTING.md: the replies come from a loopback mock model.
 * Every reply is the same sentence, so the order in which the app spends them
 * does not matter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  REPO_ROOT,
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, startOpenAiMock, waitForApp, type OpenAiMock } from './openAiMock';

const PROJECT_NAME = '季度报告';
const PROJECT_TASK = '销售数据清洗';
const RECENT_TASK = '周末出行计划';
const REPLY = '已经按同比口径核对完成';
const PASSAGE = '同比口径';
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results', 'search-project-conversations');

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

/** Send a message and wait for its reply, the `replies`-th of the conversation in view. */
async function sendTurn(page: Page, text: string, replies: number): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(text);
  await input.press('Enter');
  await expect(page.getByText(REPLY, { exact: true })).toHaveCount(replies, { timeout: READY_TIMEOUT });
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });

test('a conversation of a project is found by title, project name and content, and opens in its expanded project', async () => {
  test.setTimeout(300_000);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  mock = await startOpenAiMock(Array.from({ length: 8 }, () => ({ kind: 'complete' as const, responseText: REPLY })));
  dataRoot = createElectronDataRoot();
  const workspace = path.join(dataRoot.appDataDir, 'Home', 'search-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  app = (await launchAbuElectron(dataRoot)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  // A sidebar project bound to the fixture workspace: no native folder dialog.
  await page.evaluate(({ ws, name }) => {
    const at = 1_700_000_000_000;
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: { projects: { e2e: { id: 'e2e', name, workspacePath: ws, pinned: false, archived: false, createdAt: at, updatedAt: at, lastActiveAt: at } } },
      version: 1,
    }));
  }, { ws: workspace, name: PROJECT_NAME });
  await configureLocalMockProvider(page, mock.baseUrl);

  // ---- A task inside the project, then a recent task outside it -------------
  const projectRow = page.getByRole('button', { name: PROJECT_NAME, exact: true });
  await projectRow.hover();
  await projectRow.locator('xpath=..').getByRole('button', { name: '新任务', exact: true }).click();
  await sendTurn(page, PROJECT_TASK, 1);
  await page.getByLabel('Main navigation').getByRole('button', { name: '新任务', exact: true }).click();
  await sendTurn(page, RECENT_TASK, 1);

  // The project is collapsed: its task is off the sidebar.
  const sidebarTask = page.locator('[data-conversation-row]').filter({ hasText: PROJECT_TASK });
  await expect(sidebarTask).toBeVisible();
  // The first message of a task started on the new-task page hides the sidebar.
  await page.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await projectRow.click();
  await expect(sidebarTask).toHaveCount(0);

  // ---- No query: the recent conversations, the project's task among them ----
  await page.locator('[data-window-control="search"]').click();
  const dialog = page.getByRole('dialog', { name: '搜索' });
  const field = dialog.getByPlaceholder('搜索对话...');
  const result = (title: string) => dialog.getByRole('button', { name: title });
  const detail = (title: string) => result(title).locator('xpath=following-sibling::div');
  await expect(result(RECENT_TASK)).toBeVisible();
  await expect(detail(PROJECT_TASK)).toHaveText(PROJECT_NAME);
  await expect(detail(RECENT_TASK)).toHaveCount(0);
  await shot(page, '1-recent');

  // ---- By title ---------------------------------------------------------------
  await field.fill('销售');
  await expect(detail(PROJECT_TASK)).toContainText(PROJECT_NAME);
  await expect(result(RECENT_TASK)).toHaveCount(0);
  await shot(page, '2-by-title');

  // ---- By the project's name --------------------------------------------------
  await field.fill('季度');
  await expect(result(PROJECT_TASK)).toBeVisible();
  await expect(detail(PROJECT_TASK).locator('mark')).toHaveText('季度');
  await expect(result(RECENT_TASK)).toHaveCount(0);
  await shot(page, '3-by-project-name');

  // ---- By a passage of the messages -------------------------------------------
  // The index is written after the turn ends, and the window asks it once per query.
  await expect(async () => {
    await field.fill('');
    await field.fill(PASSAGE);
    await expect(detail(PROJECT_TASK)).toContainText(PROJECT_NAME, { timeout: 2_000 });
  }).toPass({ timeout: READY_TIMEOUT });
  await expect(detail(PROJECT_TASK).locator('mark').last()).toHaveText(PASSAGE);
  await shot(page, '4-by-content');

  // ---- Opening it expands the project and shows its row as the open one ------
  await result(PROJECT_TASK).click();
  await expect(dialog).toHaveCount(0);
  await expect(sidebarTask).toBeVisible();
  await expect(sidebarTask).toHaveAttribute('aria-current', 'true');
  await expect(sidebarTask).toBeInViewport();
  await expect(page.getByText(REPLY, { exact: true }).first()).toBeVisible();
  await shot(page, '5-opened');
});
