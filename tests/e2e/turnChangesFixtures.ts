/**
 * Shared pieces of the Electron specs that drive turns which change files:
 * the scripted tool calls of the loopback model, the launch into a project
 * whose folder sits in the test's own data root, and the reads of the files
 * on disk and of the notices.
 */
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from 'playwright';
import {
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  type ElectronDataRoot,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  startOpenAiMock,
  waitForApp,
  type MockReplyPlan,
  type OpenAiMock,
} from './openAiMock';
import { persistedStoreVersion } from './storeVersions';

export const FINAL_TEXT = '已经改好了。';

export function writeFileCall(id: string, filePath: string, content: string): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName: 'write_file', arguments: { path: filePath, content } };
}

export function editFileCall(id: string, filePath: string, oldContent: string, newContent: string): MockReplyPlan {
  return {
    kind: 'tool-call', toolCallId: id, toolName: 'edit_file',
    arguments: { path: filePath, old_content: oldContent, new_content: newContent },
  };
}

export function deleteFileCall(id: string, filePath: string): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName: 'delete_file', arguments: { path: filePath } };
}

export function commandCall(id: string, command: string): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName: 'run_command', arguments: { command } };
}

export function finalReply(text: string = FINAL_TEXT): MockReplyPlan {
  return { kind: 'complete', responseText: text };
}

export interface LaunchedProject {
  app: ElectronApplication;
  page: Page;
  workspace: string;
  dataRoot: ElectronDataRoot;
  mock: OpenAiMock;
}

/**
 * Launch the app with a project named `projectName` whose folder is `workspace`,
 * the loopback model answering with `plans` in order, and a new task open in
 * that project. The caller closes the app and the mock and removes the data
 * root in its `afterEach`.
 */
export async function launchInProject(
  projectName: string,
  plansFor: (workspace: string) => MockReplyPlan[],
  seed: (workspace: string) => void,
): Promise<LaunchedProject> {
  const dataRoot = createElectronDataRoot();
  const workspace = path.join(dataRoot.rootDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  seed(workspace);
  const mock = await startOpenAiMock(plansFor(workspace));

  const { app } = await launchAbuElectron(dataRoot);
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.evaluate(({ name, workspacePath, version }) => {
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: {
        projects: {
          'project-turn-changes': {
            id: 'project-turn-changes', name, workspacePath, pinned: false, archived: false,
            createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, lastActiveAt: 1_800_000_000_000,
          },
        },
      },
      version,
    }));
  }, { name: projectName, workspacePath: workspace, version: persistedStoreVersion('abu-projects') });
  await dismissFirstRunOverlays(page);
  await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, permissionMode: 'standard' });

  await page.getByRole('button', { name: projectName, exact: true })
    .locator('xpath=..')
    .getByRole('button', { name: '新任务', exact: true })
    .click();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible();
  return { app, page, workspace, dataRoot, mock };
}

export function notices(page: Page): Locator {
  return page.getByRole('region', { name: '通知' }).getByRole('listitem');
}

export function read(workspace: string, name: string): string {
  return fs.readFileSync(path.join(workspace, name), 'utf8');
}

export function has(workspace: string, name: string): boolean {
  return fs.existsSync(path.join(workspace, name));
}
