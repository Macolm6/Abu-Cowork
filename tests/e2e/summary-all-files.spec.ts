/**
 * Real-Electron acceptance: the task summary of the right panel holds every file of the task's
 * workspace, and the project settings hold the project's instructions and memory.
 *
 * The project settings open 项目指令 and 项目记忆 over themselves. A task of a project that has
 * no message yet offers the panel from the title bar; the launcher there opens 任务摘要, whose
 * three sections (进度, 改过的文件, 所有文件) each fold away from their title row. 所有文件 shows
 * the workspace folder as its first row and the folder's files under it, folders first. A folder
 * opens and closes on a press and stays open while a file of it is previewed in another tab. The
 * list follows the folder on disk. The workspace folder's row has a menu with the folder's
 * actions. The summary has no 操作记录, and no launcher or menu offers a tab of workspace files.
 *
 * The folder belongs to a seeded sidebar project, so no model is asked anything. The run leaves
 * three pictures of the panel among the test's output files.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type LaunchedApp,
} from './electronHelpers';
import { persistedStoreVersion } from './storeVersions';

const READY_TIMEOUT = 45_000;
const FOLLOW_TIMEOUT = 20_000;
const PROJECT_NAME = 'E2E文件列表项目';
const WORKSPACE = 'summary-files-workspace';
const FOLDER = 'reports';
const NESTED_FILE = 'q1.md';
const ROOT_FILE = 'notes.md';
const ROOT_FILE_TEXT = 'E2E-NOTES-BODY';
const ADDED_FILE = 'added-later.md';

test('任务摘要 lists every file of the workspace before the first message, previews them and follows the folder on disk', async () => {
  test.setTimeout(180_000);
  const testInfo = test.info();
  const dataRoot = createElectronDataRoot();
  const workspace = path.join(dataRoot.rootDir, WORKSPACE);
  fs.mkdirSync(path.join(workspace, FOLDER), { recursive: true });
  fs.writeFileSync(path.join(workspace, FOLDER, NESTED_FILE), 'q1\n');
  fs.writeFileSync(path.join(workspace, ROOT_FILE), `${ROOT_FILE_TEXT}\n`);
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchAbuElectron(dataRoot);
    const page = await launched.app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-chat-composer]').first()).toBeVisible({ timeout: READY_TIMEOUT });
    // A sidebar project bound to the fixture folder: no native folder dialog.
    await page.evaluate(({ ws, name, version }) => {
      const at = 1_800_000_000_000;
      window.localStorage.setItem('abu-projects', JSON.stringify({
        state: { projects: { e2e: { id: 'e2e', name, workspacePath: ws, pinned: false, archived: false, createdAt: at, updatedAt: at, lastActiveAt: at } } },
        version,
      }));
    }, { ws: workspace, name: PROJECT_NAME, version: persistedStoreVersion('abu-projects') });
    await dismissFirstRunOverlays(page);

    const projectRow = page.getByRole('group', { name: PROJECT_NAME, exact: true });
    const showPanel = page.getByRole('button', { name: '显示面板', exact: true });
    const summaryTab = page.getByRole('tab', { name: '任务摘要', exact: true });
    const visiblePanel = page.locator('[role="tabpanel"]:not([hidden])');
    const allFiles = visiblePanel.getByRole('region', { name: '所有文件', exact: true });
    const row = (name: string) => allFiles.getByRole('button', { name, exact: true });

    // Story 4: the project settings open the instructions and the memory over themselves.
    await projectRow.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '项目设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '项目设置', exact: true });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('heading', { name: '项目指令与记忆', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('project-settings.png'), animations: 'disabled' });

    await settings.getByRole('button', { name: '编辑', exact: true }).click();
    const instructions = page.getByRole('dialog', { name: '项目指令', exact: true });
    await expect(instructions).toBeVisible();
    await instructions.getByRole('button', { name: '取消', exact: true }).click();
    await expect(instructions).toHaveCount(0);
    await expect(settings).toBeVisible();

    await settings.getByRole('button', { name: '查看', exact: true }).click();
    const memory = page.getByRole('dialog', { name: '项目记忆', exact: true });
    await expect(memory).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(memory).toHaveCount(0);
    await expect(settings).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);

    // Story 1: a task with a workspace and no message offers the panel; the launcher opens the summary.
    await projectRow.getByRole('button', { name: '新任务', exact: true }).click();
    await expect(showPanel).toBeVisible();
    await showPanel.click();
    await expect(page.getByText('从这里开始', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^工作区文件/ })).toHaveCount(0);
    await page.getByRole('button', { name: /^任务摘要/ }).click();
    await expect(summaryTab).toHaveAttribute('aria-selected', 'true');

    // The summary is the progress, the changed files and all the files, with no operation
    // record; every section folds away from its title row.
    for (const title of ['进度', '改过的文件', '所有文件']) {
      const section = visiblePanel.getByRole('region', { name: title, exact: true });
      await expect(section).toBeVisible();
      await expect(section.getByRole('heading').getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    }
    await expect(visiblePanel.getByText('操作记录', { exact: true })).toHaveCount(0);

    // 所有文件: the workspace folder is the first row, its files one level in, folders first.
    await expect(row(WORKSPACE)).toHaveAttribute('aria-expanded', 'true');
    await expect(row(FOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(row(ROOT_FILE)).toBeVisible();
    const names = await allFiles.getByRole('button').allTextContents();
    expect(names.indexOf(WORKSPACE)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(WORKSPACE)).toBeLessThan(names.indexOf(FOLDER));
    expect(names.indexOf(FOLDER)).toBeLessThan(names.indexOf(ROOT_FILE));

    // The section folds away and opens again with the folder as it was.
    const allFilesTitle = allFiles.getByRole('heading', { name: '所有文件', exact: true }).getByRole('button');
    await allFilesTitle.click();
    await expect(allFilesTitle).toHaveAttribute('aria-expanded', 'false');
    await expect(row(FOLDER)).toHaveCount(0);
    await allFilesTitle.click();
    await expect(row(FOLDER)).toBeVisible();

    // Story 1: a folder opens and closes; a file is previewed in a tab of its own.
    await row(FOLDER).click();
    await expect(row(NESTED_FILE)).toBeVisible();
    await row(FOLDER).click();
    await expect(row(NESTED_FILE)).toHaveCount(0);
    await row(FOLDER).click();
    await expect(row(NESTED_FILE)).toBeVisible();
    await allFilesTitle.click();
    await expect(row(NESTED_FILE)).toHaveCount(0);
    await allFilesTitle.click();
    await expect(row(NESTED_FILE)).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath('task-summary.png'), animations: 'disabled' });

    await row(ROOT_FILE).click();
    const previewTab = page.getByRole('tab', { name: ROOT_FILE, exact: true });
    await expect(previewTab).toHaveAttribute('aria-selected', 'true');
    await expect(summaryTab).toHaveAttribute('aria-selected', 'false');
    await expect(visiblePanel).toContainText(ROOT_FILE_TEXT, { timeout: READY_TIMEOUT });

    await summaryTab.click();
    await expect(summaryTab).toHaveAttribute('aria-selected', 'true');
    // The folder is as open as it was left.
    await expect(row(NESTED_FILE)).toBeVisible();

    // Story 1: the list follows the folder on disk.
    fs.writeFileSync(path.join(workspace, ADDED_FILE), 'added\n');
    await expect(row(ADDED_FILE)).toBeVisible({ timeout: FOLLOW_TIMEOUT });
    fs.rmSync(path.join(workspace, ADDED_FILE));
    await expect(row(ADDED_FILE)).toHaveCount(0, { timeout: FOLLOW_TIMEOUT });

    // Stories 2 and 3: the workspace folder's menu holds its actions, and changing the folder
    // shows its full path above the recent folders and the folder picker.
    await allFiles.getByRole('button', { name: '更多操作', exact: true }).click();
    const folderMenu = page.getByRole('menu').first();
    for (const item of ['刷新', '在文件管理器中打开', '新建文件夹', '添加文件', '更换工作区']) {
      await expect(folderMenu.getByRole('menuitem', { name: item, exact: true })).toBeVisible();
    }
    await folderMenu.getByRole('menuitem', { name: '更换工作区', exact: true }).click();
    const changeMenu = page.getByRole('menu').last();
    await expect(changeMenu).toContainText(workspace);
    await expect(changeMenu.getByRole('menuitem', { name: '选择其他文件夹...', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('folder-menu.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // The new-tab menu offers no tab of workspace files.
    await page.getByRole('button', { name: '新建标签页', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '任务摘要', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '工作区文件', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally {
    if (launched) await closeAbuElectron(launched.app);
    removeElectronDataRoot(dataRoot);
  }
});
