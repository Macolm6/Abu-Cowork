import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import type { ElectronApplication } from 'playwright';
import { closeAbuElectron, configureLocalMockProvider, createElectronDataRoot, launchAbuElectron } from './electronHelpers';
import { CHAT_PLACEHOLDER, startOpenAiMock, waitForApp } from './openAiMock';

const run = promisify(execFile);
async function nativeDialog(app: ElectronApplication, button: string, press = false) {
  const mainPid = await app.evaluate(() => process.pid);
  const result = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(process.cwd(), 'tests/e2e/windowsQuitDialog.ps1'),
    '-ApplicationProcessId', String(mainPid), '-Button', button, ...(press ? ['-Press'] : [])],
  { windowsHide: true, timeout: 30_000, encoding: 'utf8' });
  return result.stdout;
}

test('a delayed renderer keeps exit pending and saving closes the native wait dialog', async () => {
  test.skip(process.platform !== 'win32', 'This native-dialog oracle uses Windows UI Automation.');
  test.setTimeout(90_000);
  const root = createElectronDataRoot();
  const { app } = await launchAbuElectron(root);
  let exited = false;
  try {
    const page = await app.firstWindow();
    await waitForApp(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Debugger.enable');
    // Pause the real renderer when exit preparation freezes interaction.
    // Saving continues through the production code after the debugger resumes.
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (!document.body.inert) return;
        observer.disconnect();
        // eslint-disable-next-line no-debugger
        debugger;
      });
      observer.observe(document.body, { attributes: true, attributeFilter: ['inert'] });
    });
    const paused = new Promise<void>(resolve => cdp.once('Debugger.paused', () => resolve()));
    await app.evaluate(({ app: electronApp }) => { setImmediate(() => electronApp.quit()); });
    await paused;
    const evidence = await nativeDialog(app, '继续等待');
    expect(app.process().exitCode).toBeNull();
    await test.info().attach('native-wait-dialog', { body: evidence, contentType: 'application/json' });
    await nativeDialog(app, '继续等待', true);
    await nativeDialog(app, '继续等待');
    const closing = app.waitForEvent('close');
    await cdp.send('Debugger.resume');
    await closing;
    exited = true;
  } finally {
    if (!exited) await closeAbuElectron(app);
  }
});

for (const choice of ['retry', 'cancel', 'force'] as const) {
  test(`a real filesystem failure supports ${choice} in the native exit dialog`, async () => {
    test.skip(process.platform !== 'win32', 'This native-dialog oracle uses Windows UI Automation.');
    test.setTimeout(90_000);
    const root = createElectronDataRoot();
    const mock = await startOpenAiMock([{ kind: 'complete', responseText: 'SAVE-FAILURE-REPLY' }]);
    const { app } = await launchAbuElectron(root);
    let exited = false;
    let blockedPath: string | undefined;
    const repair = () => {
      if (!blockedPath) return;
      fs.rmdirSync(blockedPath);
      fs.renameSync(`${blockedPath}.test-backup`, blockedPath);
      blockedPath = undefined;
    };
    try {
      const page = await app.firstWindow();
      await waitForApp(page);
      await configureLocalMockProvider(page, mock.baseUrl);
      await page.getByPlaceholder(CHAT_PLACEHOLDER).fill('save failure request');
      await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');
      await expect(page.getByText('SAVE-FAILURE-REPLY', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^(停止|Stop)$/ })).toHaveCount(0);
      await expect.poll(() => fs.globSync('**/conversations/index.json', { cwd: root.appDataDir }).length).toBe(1);
      const records = fs.globSync('**/conversations/index.json', { cwd: root.appDataDir });
      expect(records).toHaveLength(1);
      blockedPath = path.join(root.appDataDir, records[0]);
      fs.renameSync(blockedPath, `${blockedPath}.test-backup`);
      fs.mkdirSync(blockedPath);
      await app.evaluate(({ app: electronApp }) => { setImmediate(() => electronApp.quit()); });
      const evidence = await nativeDialog(app, '重试保存');
      expect(app.process().exitCode).toBeNull();
      await test.info().attach('native-failure-dialog', { body: evidence, contentType: 'application/json' });
      if (choice !== 'force') repair();
      if (choice === 'cancel') {
        await nativeDialog(app, '取消退出', true);
        await page.getByPlaceholder(CHAT_PLACEHOLDER).fill('draft after cancelling quit');
        await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toHaveValue('draft after cancelling quit');
        const closing = app.waitForEvent('close');
        await app.evaluate(({ app: electronApp }) => { setImmediate(() => electronApp.quit()); });
        await closing;
      } else {
        const closing = app.waitForEvent('close');
        await nativeDialog(app, choice === 'retry' ? '重试保存' : '仍然退出', true);
        await closing;
      }
      exited = true;
    } finally {
      repair();
      if (!exited) await closeAbuElectron(app);
      await mock.close();
    }
  });
}
