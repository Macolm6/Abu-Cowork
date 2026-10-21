/**
 * Real-Electron acceptance for 「改过的文件」 in the task summary: the one list
 * of the files a conversation created, changed and deleted, what a row opens,
 * the changes of each turn that changed a file, and the versions a
 * conversation left with the question before one is restored.
 *
 * A loopback model scripts each turn with file tools and commands. Every case
 * runs in a project whose folder sits in the test's own data root. The list
 * takes a command's changes once the turn's record is saved, after the reply;
 * every wait here is an assertion that retries.
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
  waitForApp,
  type MockReplyPlan,
} from './openAiMock';
import { persistedStoreVersion } from './storeVersions';

const PROJECT_NAME = 'E2E 改过的文件';
const FINAL_TEXT = '已经处理好了。';
const REPLY_TIMEOUT = 60_000;
const RECORD_TIMEOUT = 30_000;
const KEPT_COPY_NOTICE = '原文件已经不在，这是阿布保留的副本';

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

function toolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): MockReplyPlan {
  return { kind: 'tool-call', toolCallId, toolName, arguments: args };
}

function finalReply(text = FINAL_TEXT): MockReplyPlan {
  return { kind: 'complete', responseText: text };
}

/** Launch the app with a project whose folder is `workspace`, the model answering with `plans`, and a new task open in it. */
async function launchInProject(
  plansFor: (workspace: string) => MockReplyPlan[],
  seed: (workspace: string) => void,
): Promise<{ page: Page; workspace: string }> {
  const root = createElectronDataRoot();
  dataRoot = root;
  const workspace = path.join(root.rootDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  seed(workspace);
  const startedMock = await startOpenAiMock(plansFor(workspace));
  mock = startedMock;

  app = (await launchAbuElectron(root)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.evaluate(({ name, workspacePath, version }) => {
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: {
        projects: {
          'project-changed-files': {
            id: 'project-changed-files', name, workspacePath, pinned: false, archived: false,
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
  return { page, workspace };
}

/** Send a prompt and wait until its turn has ended: the reply is there and the work process has folded. */
async function runTurn(page: Page, prompt: string, finalText = FINAL_TEXT): Promise<void> {
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(prompt);
  const completed = (async () => {
    await expect(page.getByText(finalText).last()).toBeVisible({ timeout: REPLY_TIMEOUT });
    await expect(page.getByRole('button', { name: /^用时/ }).last()).toBeVisible({ timeout: REPLY_TIMEOUT });
  })();
  await composer.press('Enter');
  if (process.platform === 'win32') {
    await expect(page.getByRole('heading', { name: '操作确认', exact: true })).toBeVisible({ timeout: REPLY_TIMEOUT });
    await page.getByRole('button', { name: '确认执行', exact: true }).click();
  }
  await completed;
}

/** The tab panel in view. */
function panel(page: Page): Locator {
  return page.locator('[role="tabpanel"]:not([hidden])');
}

/** Show the right panel when it is folded, and the task summary in it. */
async function openSummary(page: Page): Promise<Locator> {
  const showPanel = page.getByRole('button', { name: '显示面板', exact: true });
  if (await showPanel.isVisible()) await showPanel.click();
  await page.getByRole('tab', { name: '任务摘要', exact: true }).click();
  return panel(page).getByRole('region', { name: '改过的文件' });
}

function rows(section: Locator): Locator {
  return section.getByTestId('changed-file-row');
}

function row(section: Locator, name: string): Locator {
  return rows(section).filter({ hasText: name });
}

async function openRowMenu(page: Page, section: Locator, name: string): Promise<Locator> {
  return openMenuFrom(page, row(section, name).getByRole('button', { name: '更多操作', exact: true }));
}

/** Press `trigger` and return the menu it opens, once the menu closed before it has left the page. */
async function openMenuFrom(page: Page, trigger: Locator): Promise<Locator> {
  await expect(page.getByRole('menu')).toHaveCount(0);
  await trigger.click();
  await expect(page.getByRole('menu')).toHaveCount(1);
  // By its id, so a nested list it opens later is not taken for it.
  return page.locator(`[role="menu"][id="${await page.getByRole('menu').getAttribute('id')}"]`);
}

/** Open the nested list of `label` in the open menu and return it. */
async function openNested(page: Page, menu: Locator, label: string): Promise<Locator> {
  const trigger = menu.getByRole('menuitem', { name: label, exact: true });
  await trigger.hover();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const nested = page.locator(`[role="menu"][aria-labelledby="${await trigger.getAttribute('id')}"]`);
  await expect(nested).toBeVisible();
  return nested;
}

function sortedRowTexts(entries: Array<[string, string]>): string[] {
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, mark]) => `${name}${mark}`);
}

function commandWriting(fileName: string, content: string): string {
  return process.platform === 'win32'
    ? `Set-Content -LiteralPath '${fileName}' -Value '${content}' -NoNewline -Encoding UTF8`
    : `printf '${content}' > ${fileName}`;
}

function keptCopies(dir: string, fileName: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return keptCopies(entryPath, fileName);
    const folders = path.dirname(entryPath).split(path.sep);
    return entry.name === fileName && folders.at(-2) === 'files' && folders.at(-3) === 'outputs' ? [entryPath] : [];
  });
}

test('the task summary lists each file the conversation created, changed or deleted once, opens it, and opens the changes of the turn the user picks', async () => {
  test.setTimeout(300_000);
  const firstPrompt = '整理一下项目文件';
  const secondPrompt = '再改一次方案';
  const { page, workspace } = await launchInProject(
    (folder) => [
      toolCall('call-read', 'read_file', { path: path.join(folder, '资料.md') }),
      toolCall('call-write-outline', 'write_file', { path: path.join(folder, '提纲.md'), content: '一、背景\n二、目标\n' }),
      toolCall('call-present', 'present_files', { files: [{ path: '提纲.md' }] }),
      toolCall('call-edit-plan', 'edit_file', { path: path.join(folder, '方案.md'), old_content: '目标甲', new_content: '目标一' }),
      toolCall('call-edit-budget', 'edit_file', { path: path.join(folder, '预算.md'), old_content: '合计 100', new_content: '合计 120' }),
      toolCall('call-delete-draft', 'delete_file', { path: path.join(folder, '旧稿.md') }),
      toolCall('call-command', 'run_command', { command: commandWriting('报表.csv', 'a,b') }),
      finalReply(),
      toolCall('call-edit-plan-again', 'edit_file', { path: path.join(folder, '方案.md'), old_content: '目标一', new_content: '目标定稿' }),
      finalReply('方案改好了。'),
      // The conversation summary the app asks for after a second turn.
      finalReply('摘要'),
    ],
    (folder) => {
      fs.writeFileSync(path.join(folder, '资料.md'), '参考资料\n');
      fs.writeFileSync(path.join(folder, '方案.md'), '# 方案\n目标甲\n');
      fs.writeFileSync(path.join(folder, '预算.md'), '合计 100\n');
      fs.writeFileSync(path.join(folder, '旧稿.md'), '旧稿第一行\n旧稿第二行\n');
    },
  );

  await runTurn(page, firstPrompt);
  expect(fs.existsSync(path.join(workspace, '旧稿.md'))).toBe(false);

  // P1-1: one list, every changed file once with its mark; the file only read is not in it.
  // The command's file joins once the turn is saved.
  let section = await openSummary(page);
  const firstTurnRows = sortedRowTexts([
    ['提纲.md', '新建'], ['方案.md', '修改'], ['预算.md', '修改'], ['旧稿.md', '删除'], ['报表.csv', '新建'],
  ]);
  await expect(rows(section)).toHaveText(firstTurnRows, { timeout: RECORD_TIMEOUT });
  await expect(section).toContainText('5 个');
  await expect(row(section, '资料.md')).toHaveCount(0);
  // The whole path shows on hover (the workspace as the system resolves it).
  await expect(row(section, '方案.md').getByRole('button').first()).toHaveAttribute('title', /^\/.*\/workspace\/方案\.md$/);

  // Every file of the card under the reply is in the list, with the same mark.
  const card = page.getByTestId('changed-files-card');
  await expect(card.getByRole('button', { name: /^已编辑 5 个文件/ })).toBeVisible();

  // P1-2: a file in place opens in the preview; a deleted file Abu kept no copy of is dimmed and opens nothing.
  await row(section, '方案.md').getByRole('button').first().click();
  await expect(page.getByRole('tab', { name: '方案.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  section = await openSummary(page);
  const gone = row(section, '旧稿.md').getByRole('button').first();
  await expect(gone).toHaveAttribute('title', '文件已经不在了');
  const tabsBefore = await page.getByRole('tab').count();
  await gone.click();
  await expect(page.getByRole('tab')).toHaveCount(tabsBefore);

  // The file manager is offered for a file in place only.
  const inPlaceMenu = await openRowMenu(page, section, '方案.md');
  await expect(inPlaceMenu.getByRole('menuitem', { name: '在文件管理器中显示', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const goneMenu = await openRowMenu(page, section, '旧稿.md');
  await expect(goneMenu.getByRole('menuitem', { name: '在文件管理器中显示', exact: true })).toHaveCount(0);
  await expect(goneMenu.getByRole('menuitem', { name: '历史版本', exact: true })).toHaveCount(0);

  // P2-1: the changes of a deleted file show what it held, line by line.
  await goneMenu.getByRole('menuitem', { name: '查看改动', exact: true }).click();
  const changesTab = panel(page).getByTestId('changes-tab');
  await expect(changesTab.getByRole('list').getByRole('button', { name: /^旧稿\.md/ })).toHaveAttribute('aria-current', 'true');
  await changesTab.getByRole('radio', { name: '单栏', exact: true }).click();
  await expect(changesTab.getByTestId('changes-diff').locator('[data-diff-row]')).toHaveText([/旧稿第一行$/, /旧稿第二行$/]);
  await expect(changesTab.getByTestId('changes-diff').locator('[data-diff-row="deleted"]')).toHaveCount(2);

  // A second turn changes the plan again: it moves to the top, still once, still 修改.
  await runTurn(page, secondPrompt, '方案改好了。');
  await expect(page.getByTestId('changed-files-card')).toHaveCount(2, { timeout: RECORD_TIMEOUT });
  section = await openSummary(page);
  await expect(rows(section).first()).toHaveText('方案.md修改', { timeout: RECORD_TIMEOUT });
  await expect(rows(section)).toHaveCount(5);

  // P2-1: a file two turns changed asks which turn, the latest first; the earlier one opens on that file.
  const planMenu = await openRowMenu(page, section, '方案.md');
  const turns = await openNested(page, planMenu, '查看改动');
  const turnItems = turns.getByRole('menuitem');
  await expect(turnItems).toHaveCount(2);
  await expect(turnItems.nth(0)).toContainText(secondPrompt);
  await expect(turnItems.nth(1)).toContainText(firstPrompt);
  await turnItems.nth(1).click();
  await expect(page.getByRole('tab', { name: '改动：报表.csv 等 5 个文件', exact: true })).toHaveAttribute('aria-selected', 'true');
  const firstTurnChanges = panel(page).getByTestId('changes-tab');
  await expect(firstTurnChanges.getByRole('list').getByRole('button', { name: /^方案\.md/ })).toHaveAttribute('aria-current', 'true');
  await expect(firstTurnChanges.getByTestId('changes-diff')).toContainText('目标甲');
  await expect(firstTurnChanges.getByTestId('changes-diff')).toContainText('目标一');
  await expect(firstTurnChanges.getByTestId('changes-diff')).not.toContainText('目标定稿');

  // P1-2: a file Abu wrote that is gone opens the copy Abu kept, with the line that says so.
  await expect.poll(() => keptCopies(dataRoot!.rootDir, '提纲.md'), { timeout: RECORD_TIMEOUT }).toHaveLength(1);
  await closeAbuElectron(app!);
  fs.rmSync(path.join(workspace, '提纲.md'));
  app = (await launchAbuElectron(dataRoot!)).app;
  const reopened = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(reopened);
  await reopened.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await reopened.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: PROJECT_NAME, exact: true })
    .click();
  await reopened.getByRole('button', { name: new RegExp(`^${firstPrompt}`) }).click();
  await expect(reopened.getByText('方案改好了。')).toBeVisible();
  const reopenedSection = await openSummary(reopened);
  await expect(rows(reopenedSection)).toHaveCount(5, { timeout: RECORD_TIMEOUT });
  await row(reopenedSection, '提纲.md').getByRole('button').first().click();
  await expect(panel(reopened).getByRole('status').filter({ hasText: KEPT_COPY_NOTICE })).toBeVisible();
});

test('a row offers the versions this conversation left, asks before restoring one, and the preview follows the restore', async () => {
  test.setTimeout(240_000);
  const readPrompt = '看看笔记';
  const prompt = '改写笔记';
  const { page, workspace } = await launchInProject(
    (folder) => [
      toolCall('call-read-notes', 'read_file', { path: path.join(folder, '笔记.md') }),
      finalReply('看过了。'),
      toolCall('call-edit-notes', 'edit_file', { path: path.join(folder, '笔记.md'), old_content: '第一版', new_content: '第二版' }),
      toolCall('call-write-new', 'write_file', { path: path.join(folder, '新文件.md'), content: '新内容\n' }),
      toolCall('call-write-chart', 'write_file', { path: path.join(folder, '图表.svg'), content: '<svg xmlns="http://www.w3.org/2000/svg"/>' }),
      finalReply(),
      // The conversation summary the app asks for after a second turn.
      finalReply('摘要'),
    ],
    (folder) => fs.writeFileSync(path.join(folder, '笔记.md'), '# 笔记\n第一版\n'),
  );
  const notesPath = path.join(workspace, '笔记.md');

  // P1-1: a conversation that changed nothing yet says where the changed files will be listed.
  await runTurn(page, readPrompt, '看过了。');
  const section = await openSummary(page);
  await expect(section).toContainText('阿布改过的文件会列在这里');
  await expect(rows(section)).toHaveCount(0);

  await runTurn(page, prompt);
  await expect(rows(section)).toHaveCount(3, { timeout: RECORD_TIMEOUT });
  // The list shows the file tools' changes while the turn runs; the menus are used once the
  // turn's record is saved, which is when its card appears under the reply.
  await expect(page.getByTestId('changed-files-card')).toHaveCount(1, { timeout: RECORD_TIMEOUT });

  // A type without versions offers none; a new file has none yet.
  const chartMenu = await openRowMenu(page, section, '图表.svg');
  await expect(chartMenu.getByRole('menuitem', { name: '历史版本', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const newFileVersions = await openNested(page, await openRowMenu(page, section, '新文件.md'), '历史版本');
  await expect(newFileVersions).toContainText('暂无历史版本');
  await page.keyboard.press('Escape');

  // The version Abu left before its edit, with the message of its turn and no size.
  let versions = await openNested(page, await openRowMenu(page, section, '笔记.md'), '历史版本');
  let items = versions.getByRole('menuitem');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('阿布修改前');
  await expect(items.first()).toContainText(prompt);
  await expect(versions).not.toContainText(/\d+(\.\d+)? (B|KB|MB)/);

  // Choosing it asks first; cancelling leaves the file as it is.
  await items.first().click();
  const question = page.getByRole('alertdialog');
  await expect(question).toHaveAccessibleName(/^把 笔记\.md 恢复到 .+ 的样子？$/);
  await expect(question).toContainText('现在的内容会另存一份，可以在历史版本里找回。');
  await question.getByRole('button', { name: '取消', exact: true }).click();
  await expect(question).toHaveCount(0);
  expect(fs.readFileSync(notesPath, 'utf8')).toBe('# 笔记\n第二版\n');

  // Restoring brings the file back and keeps what it held as 「恢复前另存」.
  versions = await openNested(page, await openRowMenu(page, section, '笔记.md'), '历史版本');
  await versions.getByRole('menuitem').first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByRole('region', { name: '通知' })).toContainText('已恢复到该版本');
  expect(fs.readFileSync(notesPath, 'utf8')).toBe('# 笔记\n第一版\n');
  versions = await openNested(page, await openRowMenu(page, section, '笔记.md'), '历史版本');
  items = versions.getByRole('menuitem');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('恢复前另存');
  await expect(items.nth(1)).toContainText('阿布修改前');
  await page.keyboard.press('Escape');

  // The preview of the file shows the restored content, and its own history marks versions the same way.
  await row(section, '笔记.md').getByRole('button').first().click();
  const preview = panel(page);
  await expect(preview).toContainText('第一版');
  const titleRowVersions = await openMenuFrom(page, preview.getByRole('button', { name: '历史版本', exact: true }));
  await expect(titleRowVersions).toContainText('恢复前另存');
  await expect(titleRowVersions).toContainText('阿布修改前');
  await expect(titleRowVersions).not.toContainText(/\d+(\.\d+)? (B|KB|MB)/);
  await page.keyboard.press('Escape');

  // Restoring from the list while the preview is open: the preview shows the restored content.
  const summarySection = await openSummary(page);
  versions = await openNested(page, await openRowMenu(page, summarySection, '笔记.md'), '历史版本');
  await versions.getByRole('menuitem').filter({ hasText: '恢复前另存' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '恢复', exact: true }).click();
  await expect.poll(() => fs.readFileSync(notesPath, 'utf8')).toBe('# 笔记\n第二版\n');
  await page.getByRole('tab', { name: '笔记.md', exact: true }).click();
  await expect(panel(page)).toContainText('第二版');
});
