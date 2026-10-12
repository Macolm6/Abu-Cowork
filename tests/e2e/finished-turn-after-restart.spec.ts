/**
 * A turn that finished stays finished across a quit and relaunch, in real
 * Electron, for a model whose stream reports no token usage.
 *
 * The user's row is written to the ledger once per run state, and the last of
 * them, `completed`, is what a relaunch reads. A reply that carries `usage` also
 * tells a relaunch that its turn finished, so the loopback mock here sends none:
 * the row's own `completed` revision is the only thing that can say so.
 *
 * The spec runs in every build. With ABU_BUILD_TARGET=enterprise it also covers
 * the renderer that is built together with the enterprise modules.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  startOpenAiMock,
  waitForApp,
  type OpenAiMock,
} from './openAiMock';

const TURN = 'finished-turn-marker';
const REPLY = 'FINISHED-TURN-REPLY';
const STOP_BUTTON = /^(停止|Stop)$/;
const FAILED_MARK = '发送失败';
const RETRY_BUTTON = '重试';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

/** The run states the ledger holds for the user row that carries `text`, in the order they were written. */
function runStatesOnDisk(root: ElectronDataRoot, text: string): string[] {
  const states: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      if (!entry.isFile() || entry.name !== 'messages.jsonl') continue;
      for (const line of fs.readFileSync(entryPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { role?: unknown; content?: unknown; runState?: unknown };
        if (row.role === 'user' && row.content === text && typeof row.runState === 'string') states.push(row.runState);
      }
    }
  };
  visit(root.appDataDir);
  return states;
}

async function launch(root: ElectronDataRoot): Promise<Page> {
  const launched = await launchAbuElectron(root);
  app = launched.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  return page;
}

test.afterEach(async () => {
  const [openApp, openMock, openDataRoot] = [app, mock, dataRoot];
  app = undefined;
  mock = undefined;
  dataRoot = undefined;
  try {
    if (openApp) await closeAbuElectron(openApp);
  } finally {
    try {
      await openMock?.close();
    } finally {
      if (openDataRoot) removeElectronDataRoot(openDataRoot);
    }
  }
});

test('a finished turn shows no failure and no retry after a restart', async () => {
  test.setTimeout(240_000);
  mock = await startOpenAiMock([{ kind: 'complete', responseText: REPLY }]);
  dataRoot = createElectronDataRoot();

  let page = await launch(dataRoot);
  await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true });
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(TURN);
  await input.press('Enter');
  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByRole('button', { name: STOP_BUTTON })).toHaveCount(0, { timeout: READY_TIMEOUT });

  // The run ends with the row's last revision on disk; the quit below is the user's, after it.
  await expect.poll(() => runStatesOnDisk(dataRoot!, TURN).at(-1), { timeout: READY_TIMEOUT }).toBe('completed');
  await closeAbuElectron(app!);
  app = undefined;

  page = await launch(dataRoot);
  const showSidebar = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole('button', { name: new RegExp(`^${TURN}`) }).first().click();
  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText(FAILED_MARK)).toHaveCount(0);
  await expect(page.getByRole('button', { name: RETRY_BUTTON, exact: true })).toHaveCount(0);
});
