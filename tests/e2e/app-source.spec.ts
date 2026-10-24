import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { REPO_ROOT, closeAbuElectron, createElectronDataRoot, dismissFirstRunOverlays, launchAbuElectron, removeElectronDataRoot, type ElectronDataRoot } from './electronHelpers';

let dataRoot: ElectronDataRoot;
let app: ElectronApplication;
let page: Page;

test.beforeEach(() => { dataRoot = createElectronDataRoot(); });
test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  removeElectronDataRoot(dataRoot);
});

async function launch(): Promise<void> {
  ({ app } = await launchAbuElectron(dataRoot));
  page = await app.firstWindow();
  await expect(page.getByTestId('app-switcher-trigger')).toBeVisible({ timeout: 45_000 });
  await dismissFirstRunOverlays(page, { apps: true });
}

async function openMarket(): Promise<void> {
  await page.getByTestId('app-switcher-trigger').click();
  await page.getByTestId('app-switcher-discover').click();
  await expect(page.getByTestId('app-market-dialog')).toBeVisible();
}

for (const name of ['mine', 'LOCAL', 'mine.']) {
  test(`refuses adding a market named ${name}`, async () => {
    const market = path.join(dataRoot.rootDir, 'market');
    fs.mkdirSync(path.join(market, '.abu-plugin'), { recursive: true });
    fs.writeFileSync(path.join(market, '.abu-plugin', 'marketplace.json'), JSON.stringify({ name, apps: [] }));
    await launch();
    await openMarket();
    await page.getByTestId('app-market-add-market').click();
    await page.getByTestId('plugin-marketplace-dir-input').fill(market);
    await page.getByTestId('plugin-marketplace-submit').click();
    await expect(page.getByTestId('plugin-marketplace-error')).toContainText('这个市场名称不能使用');
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-plugins')!).state.marketplaces as Array<{ name: string }>);
    expect(persisted.some((item) => item.name === name)).toBe(false);
  });
}

test('a legacy market cannot replace an app added from a folder', async () => {
  const market = path.join(dataRoot.rootDir, 'legacy-market');
  fs.cpSync(path.join(REPO_ROOT, 'examples', 'plugin-market'), market, { recursive: true });
  const manifestPath = path.join(market, '.abu-plugin', 'marketplace.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.name = 'local';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const source = path.join(market, 'apps', 'shop-ops');
  const appsDir = path.join(dataRoot.appDataDir, 'Home', '.abu', 'apps');
  const original = path.join(appsDir, 'shop-ops@local');
  fs.cpSync(source, original, { recursive: true });
  const originalAppPath = path.join(original, '.abu-app', 'app.json');
  const originalBytes = fs.readFileSync(originalAppPath);
  const originalFile = JSON.parse(originalBytes.toString());
  const marketApp = { ...originalFile, version: '9.0.0' };
  fs.writeFileSync(path.join(source, '.abu-app', 'app.json'), JSON.stringify(marketApp));
  for (const entry of manifest.apps) if (entry.name === 'shop-ops') entry.version = '9.0.0';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const records = [{ appId: 'shop-ops@local', name: 'shop-ops', version: originalFile.version,
    origin: { kind: 'folder', dir: source }, addedAt: '2026-10-10T00:00:00.000Z' }];
  const recordsPath = path.join(appsDir, 'added.json');
  fs.writeFileSync(recordsPath, JSON.stringify(records));
  await launch();
  // A persisted market from an earlier version goes through the normal startup path.
  await page.evaluate((dir) => {
    const persisted = JSON.parse(localStorage.getItem('abu-plugins')!);
    persisted.state.marketplaces.push({ name: 'local', dir });
    localStorage.setItem('abu-plugins', JSON.stringify(persisted));
  }, market);
  await closeAbuElectron(app);
  await launch();
  await openMarket();
  const entry = page.locator('[data-testid="app-market-entry"][data-app-id="shop-ops@local"]');
  await expect(entry).toBeVisible();
  await page.getByTestId('app-market-search').fill('no-matching-app-7264');
  await expect(page.getByTestId('app-market-empty')).toContainText('没有匹配的应用');
  await page.getByTestId('app-market-search').fill('');
  await expect(entry).toBeVisible();
  await entry.getByTestId('app-market-update').click();
  await expect(page.getByTestId('app-add-error')).toContainText('这个市场名称不能使用');
  expect(fs.readFileSync(originalAppPath)).toEqual(originalBytes);
  expect(JSON.parse(fs.readFileSync(recordsPath, 'utf8'))).toEqual(records);
});
