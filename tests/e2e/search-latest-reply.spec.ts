/**
 * Real-Electron acceptance for the conversation search: once a turn has ended,
 * a passage of that turn's reply finds the conversation.
 *
 * Deterministic per TESTING.md: the replies come from a loopback mock model.
 * Every reply is the same sentence, so the order in which the app spends them
 * does not matter.
 */
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, startOpenAiMock, waitForApp, type OpenAiMock } from './openAiMock';

const TASK = '销售数据清洗';
const REPLY = '已经按同比口径核对完成';
const PASSAGE = '同比口径';

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

test('a passage of the reply finds the conversation as soon as its first turn has ended', async () => {
  test.setTimeout(180_000);
  mock = await startOpenAiMock(Array.from({ length: 4 }, () => ({ kind: 'complete' as const, responseText: REPLY })));
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, mock.baseUrl);

  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(TASK);
  await input.press('Enter');
  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

  await page.locator('[data-window-control="search"]').click();
  const dialog = page.getByRole('dialog', { name: '搜索' });
  const field = dialog.getByPlaceholder('搜索对话...');
  // The index is written after the turn ends, and the window asks it once per query.
  await expect(async () => {
    await field.fill('');
    await field.fill(PASSAGE);
    await expect(dialog.locator('[id^="search-snippet-"]')).toContainText(REPLY, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(dialog.getByRole('button', { name: TASK })).toBeVisible();
});
