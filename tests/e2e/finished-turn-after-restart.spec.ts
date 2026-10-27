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
const QUIT_QUESTION = '阿布还在处理任务，现在退出会中断它。';
const CLOSED_MIDWAY = '上次关闭应用时，这一轮没有做完。';
const RESEND_BUTTON = '重新发送';
const STOPPED_MARK = '已停止';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

/** The run states the ledger holds for the user row that carries `text`, in the order they were written. */
function runStatesOnDisk(root: ElectronDataRoot, text: string): string[] {
  const states: string[] = [];
  for (const entryPath of fs.globSync('*/conversations/*/messages.jsonl', { cwd: root.appDataDir })) {
    for (const line of fs.readFileSync(path.join(root.appDataDir, entryPath), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { role?: unknown; content?: unknown; runState?: unknown };
      if (row.role === 'user' && row.content === text && typeof row.runState === 'string') states.push(row.runState);
    }
  }
  return states;
}

async function launch(root: ElectronDataRoot): Promise<Page> {
  const launched = await launchAbuElectron(root);
  app = launched.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  return page;
}

async function openConversation(page: Page, title: string): Promise<void> {
  const showSidebar = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
}

/** Start a quit the way Cmd+Q does, without waiting for the application to leave. */
async function requestQuit(target: ElectronApplication): Promise<void> {
  await target.evaluate(({ app: electronApp }) => {
    setImmediate(() => electronApp.quit());
  });
}

function exited(target: ElectronApplication): Promise<void> {
  const child = target.process();
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
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
  await openConversation(page, TURN);
  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText(FAILED_MARK)).toHaveCount(0);
  await expect(page.getByRole('button', { name: RETRY_BUTTON, exact: true })).toHaveCount(0);
});

test('a turn is saved by the time Stop gives way to Send, so a quit at that moment loses nothing', async () => {
  test.setTimeout(240_000);
  mock = await startOpenAiMock([{ kind: 'complete', responseText: REPLY }]);
  dataRoot = createElectronDataRoot();

  let page = await launch(dataRoot);
  await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true });
  // The page records what the ledger holds at the moment Stop leaves the page.
  const root = dataRoot;
  await page.exposeFunction('abuE2eRunStatesOnDisk', () => runStatesOnDisk(root, TURN));
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(TURN);
  await input.press('Enter');
  await expect(page.getByRole('button', { name: STOP_BUTTON })).toBeVisible({ timeout: READY_TIMEOUT });
  const statesWhenStopLeft = await page.evaluate(() => new Promise<string[]>((resolve) => {
    const stopIsGone = () => ![...document.querySelectorAll('button')]
      .some((button) => /^(停止|Stop)$/.test(button.getAttribute('aria-label') ?? button.textContent ?? ''));
    const read = () => (window as unknown as { abuE2eRunStatesOnDisk: () => Promise<string[]> })
      .abuE2eRunStatesOnDisk().then(resolve);
    if (stopIsGone()) {
      void read();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!stopIsGone()) return;
      observer.disconnect();
      void read();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  }));
  expect(statesWhenStopLeft.at(-1)).toBe('completed');

  await closeAbuElectron(app!);
  app = undefined;

  page = await launch(dataRoot);
  await openConversation(page, TURN);
  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText(FAILED_MARK)).toHaveCount(0);
  await expect(page.getByText(CLOSED_MIDWAY)).toHaveCount(0);
});

test('a quit while a turn is running asks first; the turn it interrupts says so after a restart and can be sent again', async () => {
  test.setTimeout(300_000);
  const partial = 'RUNNING-TURN-PARTIAL';
  mock = await startOpenAiMock([
    { kind: 'hold-open', partialText: partial },
    { kind: 'complete', responseText: REPLY },
  ]);
  dataRoot = createElectronDataRoot();

  let page = await launch(dataRoot);
  await configureLocalMockProvider(page, mock.baseUrl);
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(TURN);
  await input.press('Enter');
  await expect(page.getByText(partial, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

  // The user stays: the application is still there, the turn still running.
  await requestQuit(app!);
  const question = page.getByRole('alertdialog', { name: QUIT_QUESTION });
  await expect(question).toBeVisible({ timeout: READY_TIMEOUT });
  await question.getByRole('button', { name: '取消', exact: true }).click();
  await expect(question).toHaveCount(0);
  await expect(page.getByRole('button', { name: STOP_BUTTON })).toBeVisible();
  expect(app!.process().exitCode).toBeNull();

  // The user quits: the application leaves by itself, with the turn recorded as closed on.
  const left = exited(app!);
  await requestQuit(app!);
  await expect(question).toBeVisible({ timeout: READY_TIMEOUT });
  await question.getByRole('button', { name: '退出', exact: true }).click();
  await left;
  app = undefined;
  expect(runStatesOnDisk(dataRoot, TURN).at(-1)).toBe('interrupted');

  page = await launch(dataRoot);
  await openConversation(page, TURN);
  await expect(page.getByText(CLOSED_MIDWAY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText(partial, { exact: true })).toBeVisible();
  await expect(page.getByText(FAILED_MARK)).toHaveCount(0);
  await expect(page.getByText(STOPPED_MARK, { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: RESEND_BUTTON, exact: true }).click();
  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText(CLOSED_MIDWAY)).toHaveCount(0);
});
