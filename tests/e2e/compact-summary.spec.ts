/**
 * Real-Electron coverage for reading a compaction's summary (C5): the row a
 * compaction leaves in the conversation opens to the summary that replaced the
 * older messages, keeps it after a restart, and cannot be opened when the
 * stored summary is empty.
 *
 * Deterministic: a loopback mock provider answers every turn with a fixed reply
 * and every compression request with a fixed Markdown summary.
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
  compressionRequests,
  startOpenAiMock,
  waitForApp,
  type OpenAiMock,
} from './openAiMock';

const SUMMARY = '## 已确认\n- 保持接口不变';
const SUMMARY_ITEM = '保持接口不变';
const MANUAL_ROW = /上下文已压缩（手动）/;
// Manual /compact needs three rounds: the first and the last stay, the middle one is summarized.
const ROUNDS = [
  { prompt: 'E2E压缩第一轮', reply: 'E2E压缩第一轮答复' },
  { prompt: 'E2E压缩第二轮', reply: 'E2E压缩第二轮答复' },
  { prompt: 'E2E压缩第三轮', reply: 'E2E压缩第三轮答复' },
] as const;

let app: ElectronApplication | undefined;
let mock: OpenAiMock | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

function findLedgers(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findLedgers(entryPath);
    return entry.name === 'messages.jsonl' ? [entryPath] : [];
  });
}

function ledgerHolding(rootDir: string, text: string): string | undefined {
  return findLedgers(rootDir).find((ledger) => fs.readFileSync(ledger, 'utf8').includes(text));
}

/** The last revision of each ledger row, by message id. */
function ledgerRows(ledger: string): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    if (typeof row.id === 'string') rows.set(row.id, row);
  }
  return rows;
}

/** True once the turn that began with `prompt` has its reply on disk and its user row says the run completed. */
function turnSettledOnDisk(rootDir: string, prompt: string, reply: string): boolean {
  const ledger = ledgerHolding(rootDir, reply);
  if (!ledger) return false;
  const userRow = [...ledgerRows(ledger).values()].find((row) => (
    row.role === 'user' && JSON.stringify(row.content ?? '').includes(prompt)
  ));
  return userRow?.runState === 'completed';
}

async function showSidebar(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

async function startApp(root: ElectronDataRoot): Promise<Page> {
  const launched = await launchAbuElectron(root);
  app = launched.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  return page;
}

async function ask(page: Page, prompt: string, reply: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(prompt);
  await input.press('Enter');
  await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(input).toBeEditable({ timeout: READY_TIMEOUT });
}

/** Three finished rounds, then /compact; answers once the compaction row is on the page. */
async function compactThreeRounds(page: Page, root: ElectronDataRoot): Promise<void> {
  for (const { prompt, reply } of ROUNDS) await ask(page, prompt, reply);
  for (const { prompt, reply } of ROUNDS) {
    await expect.poll(() => turnSettledOnDisk(root.rootDir, prompt, reply), { timeout: 30_000 }).toBe(true);
  }
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill('/compact');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: MANUAL_ROW })).toBeVisible({ timeout: READY_TIMEOUT });
  expect(compressionRequests(mock!)).toHaveLength(1);
}

function threeRoundMock(): Promise<OpenAiMock> {
  return startOpenAiMock(
    ROUNDS.map(({ reply }) => ({ kind: 'complete', responseText: reply })),
    { compressionResponseText: SUMMARY },
  );
}

test('shows the compaction summary after /compact', async () => {
  test.setTimeout(180_000);
  dataRoot = createElectronDataRoot();
  mock = await threeRoundMock();
  const page = await startApp(dataRoot);
  await configureLocalMockProvider(page, mock.baseUrl);

  await compactThreeRounds(page, dataRoot);
  const row = page.getByRole('button', { name: MANUAL_ROW });
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText(SUMMARY_ITEM, { exact: true })).toHaveCount(0);
  // The rounds before the compaction stay where they were.
  await expect(page.getByText(ROUNDS[0].reply, { exact: true })).toBeVisible();

  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('heading', { name: '已确认', exact: true })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: SUMMARY_ITEM })).toBeVisible();
  // The row and its summary share one box; the replies carry copy buttons of their own.
  await expect(row.locator('xpath=..').getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await expect(page.getByText(ROUNDS[0].reply, { exact: true })).toBeVisible();

  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText(SUMMARY_ITEM, { exact: true })).toHaveCount(0);
});

test('keeps the summary after restart', async () => {
  test.setTimeout(240_000);
  dataRoot = createElectronDataRoot();
  mock = await threeRoundMock();
  const first = await startApp(dataRoot);
  await configureLocalMockProvider(first, mock.baseUrl);
  await compactThreeRounds(first, dataRoot);
  await expect.poll(() => ledgerHolding(dataRoot!.rootDir, SUMMARY_ITEM) !== undefined, { timeout: 30_000 }).toBe(true);
  await closeAbuElectron(app!);
  app = undefined;

  const page = await startApp(dataRoot);
  await showSidebar(page);
  await page.getByText(ROUNDS[0].prompt).first().click();
  const row = page.getByRole('button', { name: MANUAL_ROW });
  await expect(row).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(row).toHaveAttribute('aria-expanded', 'false');

  await row.click();
  await expect(page.getByRole('heading', { name: '已确认', exact: true })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: SUMMARY_ITEM })).toBeVisible();
});

test('cannot open an empty summary', async () => {
  test.setTimeout(180_000);
  dataRoot = createElectronDataRoot();
  mock = await startOpenAiMock([{ kind: 'complete', responseText: ROUNDS[0].reply }]);
  const first = await startApp(dataRoot);
  await configureLocalMockProvider(first, mock.baseUrl);
  await ask(first, ROUNDS[0].prompt, ROUNDS[0].reply);
  await expect.poll(() => turnSettledOnDisk(dataRoot!.rootDir, ROUNDS[0].prompt, ROUNDS[0].reply), { timeout: 30_000 }).toBe(true);
  await closeAbuElectron(app!);
  app = undefined;

  // A compaction row whose stored summary is empty, as damaged data would leave it.
  const ledger = ledgerHolding(dataRoot.rootDir, ROUNDS[0].reply)!;
  const userRow = [...ledgerRows(ledger).values()].find((row) => row.role === 'user')!;
  const createdAt = Number(userRow.timestamp) + 1;
  const marker = {
    id: `compact-boundary-e2e-${createdAt.toString(36)}`,
    role: 'system',
    content: '',
    timestamp: createdAt,
    compactBoundary: {
      summaryText: '',
      summarizedFromId: userRow.id,
      summarizedToId: userRow.id,
      createdAt,
      source: 'auto',
    },
  };
  fs.appendFileSync(ledger, `${JSON.stringify(marker)}\n`);

  const page = await startApp(dataRoot);
  await showSidebar(page);
  await page.getByText(ROUNDS[0].prompt).first().click();
  await expect(page.getByText(ROUNDS[0].reply, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText('没有摘要', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /上下文已压缩/ })).toHaveCount(0);
});
