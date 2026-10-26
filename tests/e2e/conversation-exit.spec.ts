import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron, configureLocalMockProvider, createElectronDataRoot,
  launchAbuElectron,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, startOpenAiMock, taskRequests, waitForApp } from './openAiMock';

async function quit(app: ElectronApplication, closeWindow = false): Promise<void> {
  const page = await app.firstWindow();
  const closed = app.waitForEvent('close', { timeout: READY_TIMEOUT });
  if (closeWindow) {
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('dist-electron-spike/index.html'));
      if (!main) throw new Error('Main window unavailable');
      main.close();
    });
  } else {
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
  }
  const confirmation = page.getByRole('alertdialog').filter({ hasText: '阿布还在处理任务，现在退出会中断它。' });
  const answering = confirmation.getByRole('button', { name: '退出', exact: true }).click({ timeout: READY_TIMEOUT })
    .catch(error => { if (!page.isClosed()) throw error; });
  await Promise.race([closed, answering]);
  await closed;
}

async function openHistory(app: ElectronApplication, title: string): Promise<Page> {
  const page = await app.firstWindow();
  await waitForApp(page);
  const showSidebar = page.getByRole('button', { name: /^(显示侧栏|Show sidebar)$/ });
  if (await showSidebar.count()) await showSidebar.click();
  await page.getByRole('button', { name: title }).first().click();
  return page;
}

for (const ending of ['stop', 'stop-close', 'stop-settled', 'complete'] as const) {
  test(`${ending}: immediate quit preserves the reply, history and next turn`, async () => {
    const testInfo = test.info();
    test.setTimeout(150_000);
    const prompt = `exit ${ending} request`;
    const reply = `exit ${ending} visible reply`;
    const continuation = `exit ${ending} continued reply`;
    const stopped = ending !== 'complete';
    const mock = await startOpenAiMock([
      stopped ? { kind: 'hold-open', partialText: reply } : { kind: 'complete', responseText: reply },
      { kind: 'complete', responseText: continuation },
    ]);
    const root = createElectronDataRoot();
    let app: ElectronApplication | undefined;
    try {
      ({ app } = await launchAbuElectron(root));
      let page = await app.firstWindow();
      await waitForApp(page);
      await configureLocalMockProvider(page, mock.baseUrl);
      if (ending === 'stop-close') {
        await page.getByRole('button', { name: /^(我|Me|登录 \/ 注册|Sign in \/ Sign up)$/ }).first().click();
        await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();
        await page.getByRole('button', { name: '偏好', exact: true }).click();
        await page.getByRole('combobox', { name: '关闭窗口时', exact: true }).press('Space');
        await page.getByRole('option', { name: '直接退出', exact: true }).click();
        await page.keyboard.press('Escape');
        // The window hands the focus back to the account button as it leaves; an
        // Enter that lands there opens the menu instead of sending the message.
        await expect(page.locator('[data-abu-settings-dialog]')).toHaveCount(0);
      }
      await page.getByPlaceholder(CHAT_PLACEHOLDER).fill(prompt);
      await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');
      await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      if (stopped) await page.getByRole('button', { name: /^(停止|Stop)$/, exact: true }).click();
      if (ending === 'stop-settled') await expect(page.getByText(/^(?:你在 .* 后停止了|You stopped after .*)$/)).toBeVisible();
      // No disk polling or terminal-state wait may precede this exit.
      await quit(app, ending === 'stop-close');
      app = undefined;
      ({ app } = await launchAbuElectron(root));
      page = await openHistory(app, prompt);
      await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(page.getByText('发送失败', { exact: true })).toHaveCount(0);
      if (stopped) await expect(page.getByText(/^(?:你在 .* 后停止了|You stopped after .*)$/)).toBeVisible();
      await page.getByPlaceholder(CHAT_PLACEHOLDER).fill('continue task');
      await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');
      await expect(page.getByText(continuation, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      const nextRequest = taskRequests(mock)[1];
      expect(JSON.stringify(nextRequest.body)).toContain(reply);
      await quit(app, ending === 'stop-close');
      app = undefined;
      ({ app } = await launchAbuElectron(root));
      page = await openHistory(app, prompt);
      await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(page.getByText(continuation, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      await testInfo.attach('durability-result', { body: JSON.stringify({ ending, root: root.rootDir, requests: taskRequests(mock).length, passed: true }), contentType: 'application/json' });
    } finally {
      if (app) await closeAbuElectron(app);
      await mock.close();
    }
  });
}
