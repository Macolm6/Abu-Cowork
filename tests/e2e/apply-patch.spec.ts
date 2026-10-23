/**
 * Real-Electron acceptance for the editing tool a model is offered by its
 * profile, and for the patch tool itself:
 *
 *  - a model of the gpt family is offered `apply_patch` and neither
 *    `edit_file` nor `write_file`; a patch it sends changes the file, the step
 *    shows the line counts, the card lists the file, and the turn can be undone;
 *  - a model of another family keeps `edit_file` / `write_file` and is not
 *    offered `apply_patch`;
 *  - a gpt model that runs `apply_patch <<'EOF' … EOF` through run_command has
 *    the patch applied by the patch tool, with no shell and no command dialog.
 *
 * A loopback model scripts each turn; the request bodies it received are what
 * prove which tools were offered.
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
  pressWhenSettled,
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

const PROJECT_NAME = 'E2E 补丁工具';
const PROMPT = '请修改方案';
const FINAL_TEXT = '已经改好了。';
const REPLY_TIMEOUT = 60_000;
const RECORD_TIMEOUT = 30_000;
const GPT_MODEL = 'gpt-5.6-sol';
const OTHER_MODEL = 'deepseek-chat';

const PLAN_BEFORE = ['# 方案', '', '第一行', '目标甲', '目标乙', '第四行', ''].join('\n');
const PLAN_AFTER = ['# 方案', '', '第一行', '目标一', '目标二', '第四行', ''].join('\n');

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

function planPatch(file: string): string {
  return [
    '*** Begin Patch',
    `*** Update File: ${file}`,
    '@@',
    ' 第一行',
    '-目标甲',
    '-目标乙',
    '+目标一',
    '+目标二',
    ' 第四行',
    '*** End Patch',
  ].join('\n');
}

function applyPatchCall(id: string, input: string): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName: 'apply_patch', arguments: { input } };
}

function editFileCall(id: string, filePath: string, oldContent: string, newContent: string): MockReplyPlan {
  return {
    kind: 'tool-call', toolCallId: id, toolName: 'edit_file',
    arguments: { path: filePath, old_content: oldContent, new_content: newContent },
  };
}

function commandCall(id: string, command: string): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName: 'run_command', arguments: { command } };
}

function finalReply(): MockReplyPlan {
  return { kind: 'complete', responseText: FINAL_TEXT };
}

/** The function names the task's first request offered the model. */
function offeredTools(started: OpenAiMock): string[] {
  const body = taskRequests(started)[0]?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined;
  return (body?.tools ?? []).map((tool) => tool.function?.name ?? '').sort();
}

/** The tool results the task's second request carried back to the model. */
function toolResults(started: OpenAiMock): string[] {
  const body = taskRequests(started)[1]?.body as { messages?: Array<{ role?: string; content?: unknown }> } | undefined;
  return (body?.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
}

async function launchInProject(
  modelId: string,
  plansFor: (workspace: string) => MockReplyPlan[],
): Promise<{ page: Page; workspace: string }> {
  const root = createElectronDataRoot();
  dataRoot = root;
  const workspace = path.join(root.rootDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, '方案.md'), PLAN_BEFORE);
  const startedMock = await startOpenAiMock(plansFor(workspace));
  mock = startedMock;

  app = (await launchAbuElectron(root)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.evaluate(({ name, workspacePath, version }) => {
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: {
        projects: {
          'project-patch': {
            id: 'project-patch', name, workspacePath, pinned: false, archived: false,
            createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, lastActiveAt: 1_800_000_000_000,
          },
        },
      },
      version,
    }));
  }, { name: PROJECT_NAME, workspacePath: workspace, version: persistedStoreVersion('abu-projects') });
  await dismissFirstRunOverlays(page);
  await configureLocalMockProvider(page, startedMock.baseUrl, { modelId, supportsTools: true, permissionMode: 'standard' });

  await page.getByRole('button', { name: PROJECT_NAME, exact: true })
    .locator('xpath=..')
    .getByRole('button', { name: '新任务', exact: true })
    .click();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible();
  return { page, workspace };
}

async function runTurn(page: Page): Promise<void> {
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(PROMPT);
  await composer.press('Enter');
  await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ }).last()).toBeVisible({ timeout: REPLY_TIMEOUT });
}

async function showSteps(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^用时/ }).first().click();
  const group = page.getByRole('button', { name: /^(修改了|创建了|读取了|执行了|调用了)/ }).first();
  await expect(group).toBeVisible();
  if ((await group.getAttribute('aria-expanded')) === 'false') await group.click();
}

function changedFilesCard(page: Page): Locator {
  return page.getByTestId('changed-files-card');
}

test('a gpt model is offered apply_patch only; its patch changes the file, shows on the step and the card, and the turn can be undone', async () => {
  test.setTimeout(200_000);
  const { page, workspace } = await launchInProject(GPT_MODEL, (folder) => [
    applyPatchCall('call-patch', planPatch(path.join(folder, '方案.md'))),
    finalReply(),
  ]);

  await runTurn(page);
  const offered = offeredTools(mock!);
  expect(offered).toContain('apply_patch');
  expect(offered).not.toContain('edit_file');
  expect(offered).not.toContain('write_file');
  expect(fs.readFileSync(path.join(workspace, '方案.md'), 'utf8')).toBe(PLAN_AFTER);

  await showSteps(page);
  await expect(page.getByRole('button', { name: '+2 −2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '在右侧预览 方案.md', exact: true })).toBeVisible();

  const card = changedFilesCard(page);
  await expect(card).toHaveCount(1, { timeout: RECORD_TIMEOUT });
  await expect(card.getByRole('button', { name: /^已编辑 方案\.md/ })).toBeVisible();

  await card.getByRole('button', { name: '撤销', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '撤销这一轮的文件改动？' });
  await pressWhenSettled(dialog.getByRole('button', { name: '撤销', exact: true }));
  await expect(card.getByRole('button', { name: /^已撤销 方案\.md 的改动/ })).toBeVisible();
  expect(fs.readFileSync(path.join(workspace, '方案.md'), 'utf8')).toBe(PLAN_BEFORE);
});

test('a model of another family keeps edit_file and write_file and is not offered apply_patch', async () => {
  test.setTimeout(200_000);
  const { page, workspace } = await launchInProject(OTHER_MODEL, (folder) => [
    editFileCall('call-edit', path.join(folder, '方案.md'), '目标甲\n目标乙', '目标一\n目标二'),
    finalReply(),
  ]);

  await runTurn(page);
  const offered = offeredTools(mock!);
  expect(offered).toContain('edit_file');
  expect(offered).toContain('write_file');
  expect(offered).not.toContain('apply_patch');
  expect(fs.readFileSync(path.join(workspace, '方案.md'), 'utf8')).toBe(PLAN_AFTER);

  const card = changedFilesCard(page);
  await expect(card).toHaveCount(1, { timeout: RECORD_TIMEOUT });
  await expect(card.getByRole('button', { name: /^已编辑 方案\.md/ })).toBeVisible();
});

test('a gpt model that runs apply_patch as a shell command has the patch applied by the patch tool, with no command dialog', async () => {
  test.setTimeout(200_000);
  const { page, workspace } = await launchInProject(GPT_MODEL, (folder) => [
    commandCall('call-shell', `apply_patch <<'EOF'\n${planPatch(path.join(folder, '方案.md'))}\nEOF`),
    finalReply(),
  ]);

  await runTurn(page);
  // The model got the patch tool's own result back for its command.
  expect(toolResults(mock!)).toEqual([expect.stringContaining('补丁已应用')]);
  expect(fs.readFileSync(path.join(workspace, '方案.md'), 'utf8')).toBe(PLAN_AFTER);
  // No command confirmation was ever shown: the turn ended on its own under 「standard」.
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await showSteps(page);
  await expect(page.getByRole('button', { name: '+2 −2', exact: true })).toBeVisible();
  const card = changedFilesCard(page);
  await expect(card).toHaveCount(1, { timeout: RECORD_TIMEOUT });
});
