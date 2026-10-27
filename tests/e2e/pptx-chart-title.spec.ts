/**
 * Real-Electron acceptance: a chart whose title was deleted in PowerPoint draws no title in the
 * slide preview, and a chart whose series have no fill of their own draws them in the theme colors.
 *
 * The deck is `src/components/preview/__fixtures__/chart-titles.pptx`: a column, a pie and a line
 * chart saved with `c:autoTitleDeleted val="1"` and no `c:title`, then a column chart titled
 * "Quarterly revenue". It is opened from the workspace file list of a seeded sidebar project, so
 * no model is asked anything. Charts are drawn as SVG, so their words are read from the page.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  openTaskSummaryOfProject,
  removeElectronDataRoot,
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';
import { persistedStoreVersion } from './storeVersions';

const READY_TIMEOUT = 45_000;
const PROJECT_NAME = 'E2E演示文稿项目';
const DECK_NAME = 'chart-titles.pptx';
const FIXTURE = path.join(REPO_ROOT, 'src/components/preview/__fixtures__/chart-titles.pptx');

test.describe('pptx chart titles', () => {
  let dataRoot: ElectronDataRoot;
  let app: ElectronApplication;
  let page: Page;

  /** The preview in view: the one tab panel that is not hidden. */
  const panel = (): Locator => page.locator('[role="tabpanel"]:not([hidden])');

  test.beforeAll(async () => {
    dataRoot = createElectronDataRoot();
    const workspace = path.join(dataRoot.rootDir, 'pptx-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(workspace, DECK_NAME));

    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    page = await app.firstWindow();
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

    await openTaskSummaryOfProject(page, PROJECT_NAME);
  });

  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
  });

  test('a chart whose title was deleted draws none, and a titled chart draws its own title', async () => {
    await page.getByRole('button', { name: DECK_NAME, exact: true }).first().click();

    const charts = panel().locator('.chart-node');
    await expect(charts).toHaveCount(4, { timeout: READY_TIMEOUT });
    // The titled chart is drawn last; once its title is on the page every chart has been drawn.
    await expect(charts.nth(3).locator('svg text', { hasText: 'Quarterly revenue' })).toHaveCount(1, { timeout: READY_TIMEOUT });

    await expect(panel().locator('svg text', { hasText: '图表标题' })).toHaveCount(0);
    // The pie chart's title would otherwise be its series name.
    await expect(charts.nth(1).locator('svg text', { hasText: 'Revenue' })).toHaveCount(0);
  });

  test('draws the bars, slices and line of charts whose colors come from the theme', async () => {
    const charts = panel().locator('.chart-node');
    await expect(charts).toHaveCount(4, { timeout: READY_TIMEOUT });
    await expect(charts.nth(3).locator('svg text', { hasText: 'Quarterly revenue' })).toHaveCount(1, { timeout: READY_TIMEOUT });

    // No series in the deck has a fill of its own: series n and pie point n take accentN+1 of the
    // Office theme. Each color is drawn once per bar or slice and once as its legend swatch.
    const ACCENT = ['rgb(79,129,189)', 'rgb(192,80,77)', 'rgb(155,187,89)', 'rgb(128,100,162)'];
    await expect(charts.nth(0).locator(`svg path[fill="${ACCENT[0]}"]`)).toHaveCount(5);
    for (const color of ACCENT) {
      await expect(charts.nth(1).locator(`svg path[fill="${color}"]`)).toHaveCount(2);
    }
    await expect(charts.nth(2).locator(`svg path[fill="none"][stroke="${ACCENT[0]}"]`)).not.toHaveCount(0);
    await expect(charts.nth(3).locator(`svg path[fill="${ACCENT[0]}"]`)).toHaveCount(5);  });
});
