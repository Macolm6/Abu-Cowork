/**
 * Black-box signed deployment regression, separate from the seven unsigned
 * install-loop cases. An opt-in private runner publishes real fixtures and
 * supplies a local Console endpoint with transport-level tampering on two of
 * them. No renderer/main network mocks or private implementation imports.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Page } from 'playwright';
import { closeAbuElectron, dismissFirstRunOverlays, launchAbuElectron, removeElectronDataRoot, type ElectronDataRoot } from './electronHelpers';

const loginFixture = process.env.ABU_E2E_PLUGIN_LOGIN_FIXTURE ?? '';
const timeout = 60_000;
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
interface CatalogItem { name: string; latestVersion: string; sha256: string }
interface SignedFixture {
  variants: { zip: string; signature: string };
  readValidArtifact(): Promise<CatalogItem>;
  bindToConsole(app: ElectronApplication, page: Page): Promise<void>;
}

function card(page: Page, name: string) {
  return page.getByTestId('enterprise-plugin-row').filter({ has: page.getByTitle(name, { exact: true }) });
}
function pluginRoot(root: ElectronDataRoot) {
  return path.join(root.appDataDir, 'Home', '.abu', 'plugin-packages');
}
function records(root: ElectronDataRoot): { name: string; version: string; checksum: string }[] {
  const file = path.join(pluginRoot(root), 'installed.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

async function bind(app: ElectronApplication, page: Page, fixture: SignedFixture) {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByText(/交给阿布就行啦|Leave it to Abu/).or(page.getByPlaceholder(/想让阿布帮你做点什么？|What can Abu help you with\?/)).first()).toBeVisible({ timeout });
  await dismissFirstRunOverlays(page);
  await fixture.bindToConsole(app, page);
  await page.getByLabel('Main navigation').getByRole('button', { name: /^(扩展|Extensions)$/ }).click();
  await page.getByRole('main').getByRole('button', { name: /^(插件|Plugins)$/ }).click();
  await page.getByTestId('extensions-source-market').click();
}

test.describe.serial('signed organization plugin distribution (real Electron)', () => {
  test.skip(!loginFixture,
    'run with a signed Console and the opt-in private transport fixture runner');
  let app: ElectronApplication;
  let page: Page;
  let dataRoot: ElectronDataRoot;
  let valid: CatalogItem;
  let fixture: SignedFixture;

  test.beforeAll(async () => {
    const module = await import(pathToFileURL(loginFixture).href);
    fixture = module.createSignedPluginFixture();
    valid = await fixture.readValidArtifact();
    const launched = await launchAbuElectron();
    dataRoot = launched; app = launched.app; page = await app.firstWindow();
    await bind(app, page, fixture);
  });
  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
  });

  test('uses the advertised key, confirms a signed artifact and installs its files and record', async () => {
    await card(page, valid.name).getByRole('button', { name: '安装', exact: true }).click();
    const dialog = page.getByTestId('plugin-install-disclosure');
    await expect(page.getByTestId('plugin-install-confirm')).toBeVisible({ timeout });
    // This warning is driven by the actual verifier result, not catalog metadata.
    await expect(dialog.getByTestId('plugin-disclosure-unsigned')).toHaveCount(0);
    await expect(dialog).not.toContainText('未签名');
    await page.getByTestId('plugin-install-confirm').click();
    await expect(dialog).toBeHidden({ timeout });
    const installed = path.join(pluginRoot(dataRoot), 'enterprise', valid.name, valid.latestVersion);
    await expect.poll(() => fs.existsSync(path.join(installed, '.abu-plugin', 'plugin.json')) &&
      fs.existsSync(path.join(installed, 'skills', 'signing-fixture', 'SKILL.md')), { timeout }).toBe(true);
    expect(records(dataRoot).find(item => item.name === valid.name)).toMatchObject({ version: valid.latestVersion, checksum: valid.sha256 });
    await expect.poll(() => fs.existsSync(path.join(pluginRoot(dataRoot), 'enterprise', '.staging', valid.name)), { timeout }).toBe(false);
    await expect(card(page, valid.name)).toContainText('已安装');
  });

  for (const [variant, reason] of [['zip', 'sha256_mismatch'], ['signature', 'signature_invalid']] as const) {
    test(`rejects ${reason} without a plugin directory, staging tree or install record`, async () => {
      const name = fixture.variants[variant];
      await card(page, name).getByRole('button', { name: '安装', exact: true }).click();
      const dialog = page.getByTestId('plugin-install-disclosure');
      await expect(page.getByRole('main').getByText(reason, { exact: false })).toBeVisible({ timeout });
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('plugin-install-confirm')).toHaveCount(0);
      expect(fs.existsSync(path.join(pluginRoot(dataRoot), 'enterprise', name))).toBe(false);
      expect(fs.existsSync(path.join(pluginRoot(dataRoot), 'enterprise', '.staging', name))).toBe(false);
      expect(records(dataRoot).some(item => item.name === name)).toBe(false);
    });
  }
});
