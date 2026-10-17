/** Real-Electron hit testing for the settings button and scrim over native drag regions. */
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  appRegionAt,
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
/** 1080p at 150% scaling: the geometry the dead-click reports came from. */
const REPORTED_VIEWPORT = { width: 1200, height: 745 };

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('Electron overlay hit testing — window drag lanes', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('the settings close button and the scrim over the title bar take pointer input', async () => {
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);

    // A maximized window must be restored before setting its content size.
    await app.evaluate(({ BrowserWindow }, viewport) => {
      const [mainWindow] = BrowserWindow.getAllWindows();
      if (!mainWindow) throw new Error('main window missing');
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      mainWindow.setContentSize(viewport.width, viewport.height);
    }, REPORTED_VIEWPORT);

    await page.getByRole('button', { name: /^(我|Me|登录 \/ 注册|Sign in \/ Sign up)$/ }).first().click();
    await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();

    const dialog = page.locator('[data-abu-settings-dialog]');
    await expect(dialog).toBeVisible({ timeout: READY_TIMEOUT });
    const closeButton = page.locator('[data-abu-settings-close]');
    await expect(closeButton).toBeVisible();

    const hitTest = await page.evaluate(() => {
      const close = document.querySelector('[data-abu-settings-close]');
      const box = document.querySelector('[data-abu-settings-dialog]');
      if (!close || !box) throw new Error('settings dialog did not render its close button');
      const rect = close.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        closeAppRegion: getComputedStyle(close).webkitAppRegion,
        boxAppRegion: getComputedStyle(box).webkitAppRegion,
        receivesHit: Boolean(hit && (hit === close || close.contains(hit))),
        centre: { x, y },
      };
    });

    // The marker on the dialog box (and on the scrim behind it) is the entire
    // mechanism: the box's rectangle covers the button, so the button needs no
    // region of its own. Asserting the button stays `none` is the regression
    // guard for 6239c807 — putting the descendant rule back would leak overlay
    // geometry into the title bar.
    expect(hitTest.boxAppRegion).toBe('no-drag');
    expect(hitTest.closeAppRegion).toBe('none');
    expect(hitTest.receivesHit).toBe(true);
    // The authoritative check: Chromium unions/subtracts in DOCUMENT order, so
    // ask the resolver that models that, not the stacking order.
    expect(await appRegionAt(page, hitTest.centre.x, hitTest.centre.y)).toBe('no-drag');
    await closeButton.click();
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: /^(我|Me|登录 \/ 注册|Sign in \/ Sign up)$/ }).first().click();
    await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();
    await expect(dialog).toBeVisible();
    const scrimHit = await page.evaluate(() => {
      const lane = document.querySelector('[data-abu-windows-drag-region="titlebar"], [data-abu-macos-drag-strip]');
      if (!lane) throw new Error('native title-bar drag region missing');
      const rect = lane.getBoundingClientRect();
      const point = { x: rect.right - 16, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        point,
        laneAppRegion: getComputedStyle(lane).webkitAppRegion,
        laneVisible: rect.width > 32 && rect.height > 0,
        scrimReceivesHit: hit?.hasAttribute('data-electron-no-drag') === true
          && getComputedStyle(hit).position === 'fixed'
          && !hit.hasAttribute('data-ds-layer'),
      };
    });
    expect(scrimHit.laneVisible).toBe(true);
    expect(scrimHit.laneAppRegion).toBe('drag');
    expect(scrimHit.scrimReceivesHit).toBe(true);
    expect(await appRegionAt(page, scrimHit.point.x, scrimHit.point.y)).toBe('no-drag');
    await page.mouse.click(scrimHit.point.x, scrimHit.point.y);
    await expect(dialog).toBeHidden();
  });
});
