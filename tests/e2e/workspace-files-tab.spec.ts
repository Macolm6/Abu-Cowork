/**
 * Real-Electron acceptance: the workspace files of a task are a tab of the right panel.
 *
 * A task of a project that has no message yet offers the panel from the title bar; the launcher
 * there opens 工作区文件, which lists the workspace folder, folders first. A folder opens and
 * closes on a press and stays open while a file of it is previewed in another tab. The list
 * follows the folder on disk. The new-tab menu and 查看文件 in the task summary return to the same
 * tab, and the sidebar offers no file tree of its own.
 *
 * The folder belongs to a seeded sidebar project, so no model is asked anything.
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
const FOLDER = 'reports';
const NESTED_FILE = 'q1.md';
const ROOT_FILE = 'notes.md';
const ROOT_FILE_TEXT = 'E2E-NOTES-BODY';
const ADDED_FILE = 'added-later.md';

test('工作区文件 opens in the right panel before the first message, lists and previews files, and follows the folder on disk', async () => {
  test.setTimeout(180_000);
  const dataRoot = createElectronDataRoot();
  const workspace = path.join(dataRoot.rootDir, 'files-tab-workspace');
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
    const filesTab = page.getByRole('tab', { name: '工作区文件', exact: true });
    const visiblePanel = page.locator('[role="tabpanel"]:not([hidden])');
    const row = (name: string) => visiblePanel.getByRole('button', { name, exact: true });

    // The sidebar has no file tree of its own, and no page shows a panel button without a task.
    await expect(projectRow.getByRole('button', { name: '新任务', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '项目文件' })).toHaveCount(0);
    await expect(showPanel).toHaveCount(0);

    // Story 1: a task with a workspace and no message offers the panel; the launcher opens the list.
    await projectRow.getByRole('button', { name: '新任务', exact: true }).click();
    await expect(showPanel).toBeVisible();
    await showPanel.click();
    await expect(page.getByText('从这里开始', { exact: true })).toBeVisible();
    await expect(showPanel).toHaveCount(0);
    await page.getByRole('button', { name: /^工作区文件/ }).click();
    await expect(filesTab).toHaveAttribute('aria-selected', 'true');
    await expect(row(FOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(row(ROOT_FILE)).toBeVisible();
    // Folders come first.
    const names = await visiblePanel.getByRole('button').allTextContents();
    expect(names.indexOf(FOLDER)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(FOLDER)).toBeLessThan(names.indexOf(ROOT_FILE));

    // Story 2: a folder opens and closes; a file is previewed in a tab of its own.
    await row(FOLDER).click();
    await expect(row(NESTED_FILE)).toBeVisible();
    await row(FOLDER).click();
    await expect(row(NESTED_FILE)).toHaveCount(0);
    await row(FOLDER).click();
    await expect(row(NESTED_FILE)).toBeVisible();

    await row(ROOT_FILE).click();
    const previewTab = page.getByRole('tab', { name: ROOT_FILE, exact: true });
    await expect(previewTab).toHaveAttribute('aria-selected', 'true');
    await expect(filesTab).toHaveAttribute('aria-selected', 'false');
    await expect(visiblePanel).toContainText(ROOT_FILE_TEXT, { timeout: READY_TIMEOUT });

    await filesTab.click();
    await expect(filesTab).toHaveAttribute('aria-selected', 'true');
    // The folder is as open as it was left.
    await expect(row(NESTED_FILE)).toBeVisible();

    // Story 3: the list follows the folder on disk, and the header offers 刷新 beside the
    // folder's name. (That the button reads the folder again is a unit test's to show: here
    // the list has already followed every change by itself.)
    fs.writeFileSync(path.join(workspace, ADDED_FILE), 'added\n');
    await expect(row(ADDED_FILE)).toBeVisible({ timeout: FOLLOW_TIMEOUT });
    fs.rmSync(path.join(workspace, ADDED_FILE));
    await expect(row(ADDED_FILE)).toHaveCount(0, { timeout: FOLLOW_TIMEOUT });
    await expect(visiblePanel.getByRole('heading', { name: 'files-tab-workspace', exact: true })).toBeVisible();
    await expect(visiblePanel.getByRole('button', { name: '刷新', exact: true })).toBeVisible();

    // Story 1: the new-tab menu returns to the open list and adds no second one.
    await previewTab.click();
    await page.getByRole('button', { name: '新建标签页', exact: true }).click();
    await page.getByRole('menuitem', { name: '工作区文件', exact: true }).click();
    await expect(filesTab).toHaveCount(1);
    await expect(filesTab).toHaveAttribute('aria-selected', 'true');

    // Story 1: 查看文件 in the task summary returns to it as well.
    await page.getByRole('button', { name: '新建标签页', exact: true }).click();
    await page.getByRole('menuitem', { name: '任务摘要', exact: true }).click();
    await expect(page.getByRole('tab', { name: '任务摘要', exact: true })).toHaveAttribute('aria-selected', 'true');
    await visiblePanel.getByRole('button', { name: '查看文件', exact: true }).click();
    await expect(filesTab).toHaveCount(1);
    await expect(filesTab).toHaveAttribute('aria-selected', 'true');
    await expect(row(ROOT_FILE)).toBeVisible();
  } finally {
    if (launched) await closeAbuElectron(launched.app);
    removeElectronDataRoot(dataRoot);
  }
});
