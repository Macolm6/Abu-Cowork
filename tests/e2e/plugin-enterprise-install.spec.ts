/**
 * The ORGANIZATION plugin loop in the real Electron shell, against a real
 * enterprise console over HTTP: bind through the product's own login UI, open
 * the 插件 tab's 「市场」 — which for a bound client IS the organization catalog —
 * read the disclosure, install, verify the ON-DISK layout, uninstall, and (on a
 * spec-owned package) update.
 *
 * What the IA assertions here prove, and what they do NOT: on a bound shell
 * 「市场」 is the console catalog and 「我的」 is what this user wrote
 * themselves, so an organization install shows up in the first and never in the
 * second. That is a statement about which panel lists what — it is NOT the
 * proof that installs are keyed `name@marketplace`. A bound client has no
 * personal-market surface left to install a same-named plugin from, so that
 * keying is pinned by unit tests instead: src/core/plugin/enterpriseMarket.test.ts
 * (an install is enterprise by its marketplace, not its name) and
 * src/core/plugin/installedStore.test.ts (records are stored and removed by the
 * composite key).
 *
 * Why this exists: every other test of this feature mocks either the installer
 * or the filesystem, so the on-disk layout it produces had never been proven by
 * an end-to-end run. That layout broke twice during development —
 *   1. the staging tree was written UNDER `enterprise/<name>/`, which the
 *      update path's uninstall deletes, so every update wiped the tree it was
 *      about to copy from;
 *   2. `.abu-plugin/` is a dot-directory and a dotfile-skipping copy dropped it
 *      silently, producing an installed package with no manifest.
 * Both are invisible to a mocked filesystem, so the paths below are asserted
 * LITERALLY rather than through any helper that could drift with the product.
 *
 * The private fixture supplied by ABU_E2E_PLUGIN_LOGIN_FIXTURE prepares the
 * real organization and completes desktop sign-in. Run the private runner
 * with an enterprise renderer build to exercise all seven cases.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
/** Install/update round trips include a real download + extract + copy. */
const INSTALL_TIMEOUT = 60_000;
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const LOGIN_FIXTURE = process.env.ABU_E2E_PLUGIN_LOGIN_FIXTURE ?? '';

// Public (localized) UI. Placeholders that are URLs/emails are locale-neutral.
const WELCOME = /交给阿布就行啦|Leave it to Abu/;
const CHAT_PLACEHOLDER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;
const EXTENSIONS = /^(扩展|Extensions)$/;
const PLUGINS_TAB = /^(插件|Plugins)$/;
const CANCEL_BUTTON = /^(取消|Cancel)$/;

// EnterprisePluginTab is single-locale by design (see its module header), so
// these are exact strings, not alternations.
const BADGE_REVIEWED = '组织审核';
const BADGE_INSTALLED = '已安装';
const BADGE_UPDATABLE = '可更新';
const ACTION_INSTALL = '安装';
const ACTION_UPDATE = '更新';

interface CatalogEntry {
  name: string;
  latestVersion: string;
  sha256: string;
  disclosure: { skills: string[]; mcpServers: { name: string }[]; ignoredPayloads: string[] };
}
interface UnsignedFixture {
  catalogName: string;
  ownedName: string;
  firstVersion: string;
  nextVersion: string;
  prepare(): Promise<CatalogEntry>;
  publishUpdate(): Promise<void>;
  cleanup(): Promise<void>;
  bindToConsole(app: ElectronApplication, page: Page): Promise<void>;
}

// ─── on-disk layout (asserted literally — see the file header) ───────────────

/**
 * `<appDataDir>/Home` is the isolated HOME `launchAbuElectron` gives the shell
 * (electron/main.cjs redirects app.getPath('home') under ABU_E2E_APP_DATA_ROOT),
 * so `~/.abu/...` below is this run's own tree and never a developer's real one.
 */
function homeDir(dataRoot: ElectronDataRoot): string {
  return path.join(dataRoot.appDataDir, 'Home');
}

function enterpriseRoot(dataRoot: ElectronDataRoot): string {
  return path.join(homeDir(dataRoot), '.abu', 'plugin-packages', 'enterprise');
}

function stagingRoot(dataRoot: ElectronDataRoot): string {
  return path.join(enterpriseRoot(dataRoot), '.staging');
}

/**
 * Names left under the staging root.
 *
 * The commit removes `.staging/<name>` — the tree that actually holds the
 * unpacked third-party files — but not the `.staging` parent itself, which
 * survives as an empty directory. So the invariant worth asserting is that
 * nothing is STAGED, not that the directory is absent: an empty `.staging`
 * holds no package. Returns `[]` when the root was never created.
 */
function stagedEntries(dataRoot: ElectronDataRoot): string[] {
  const root = stagingRoot(dataRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root);
}

function installedManifest(dataRoot: ElectronDataRoot): string {
  return path.join(homeDir(dataRoot), '.abu', 'plugin-packages', 'installed.json');
}

interface InstalledRecord {
  key: string;
  marketplace: string;
  name: string;
  version: string;
  checksum?: string;
  contributed: { skills: string[]; mcpServers: string[] };
}

function readInstalled(dataRoot: ElectronDataRoot): InstalledRecord[] {
  const file = installedManifest(dataRoot);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')) as InstalledRecord[];
}

function installedRecord(dataRoot: ElectronDataRoot, name: string): InstalledRecord | undefined {
  return readInstalled(dataRoot).find((p) => p.name === name);
}

function expectRetiredVersions(packageRoot: string, name: string, versions: string[]): void {
  const entries = fs.readdirSync(packageRoot, { withFileTypes: true });
  expect(entries).toHaveLength(versions.length);
  const retiredVersions = entries.map((entry) => {
    expect(entry.name).toMatch(/^\.abu-plugin-backup-[a-f0-9]{32}-package-0$/);
    expect(entry.isDirectory()).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(packageRoot, entry.name, '.abu-plugin', 'plugin.json'), 'utf8',
    )) as { name: string; version: string };
    expect(manifest.name).toBe(name);
    return manifest.version;
  });
  expect(retiredVersions.sort()).toEqual([...versions].sort());
}

// ─── UI journey ──────────────────────────────────────────────────────────────

async function waitForWelcomeScreen(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.getByText(WELCOME).or(page.getByPlaceholder(CHAT_PLACEHOLDER)).first(),
  ).toBeVisible({ timeout: READY_TIMEOUT });
}

async function openPluginsTab(page: Page): Promise<void> {
  // Scope the sidebar entry to the navigation region and the tab to the panel
  // so neither can match the other by accident.
  await page.getByLabel('Main navigation').getByRole('button', { name: EXTENSIONS }).click();
  const panel = page.getByRole('main');
  await expect(panel.getByRole('button', { name: PLUGINS_TAB })).toBeVisible({ timeout: READY_TIMEOUT });
  await panel.getByRole('button', { name: PLUGINS_TAB }).click();
  await selectSource(page, 'market');
}

/**
 * 市场 | 我的 — the source sub-nav every Extensions tab carries. There is no
 * 我的/组织 scope toggle any more: for a bound client the organization catalog
 * IS the 「市场」 panel, so 「市场」 is where the whole organization loop happens
 * and 「我的」 stays what the user wrote themselves.
 */
function sourceTab(page: Page, source: 'market' | 'mine') {
  return page.getByTestId(`extensions-source-${source}`);
}

async function selectSource(page: Page, source: 'market' | 'mine'): Promise<void> {
  await sourceTab(page, source).click();
  await expect(sourceTab(page, source)).toHaveAttribute('aria-selected', 'true');
}

/**
 * The organization catalog row for `name`.
 *
 * The catalog is a full-width list (`MarketplaceEntryRow`, the same row the OSS
 * 插件 市场 uses), so the row itself carries a testid; `has:` then picks the one
 * whose name element matches EXACTLY — filtering rows by text would also match
 * a row whose name merely contains this one.
 */
function orgCard(page: Page, name: string) {
  return page
    .getByRole('main')
    .getByTestId('enterprise-plugin-row')
    .filter({ has: page.getByTitle(name, { exact: true }) });
}

/** 卸载 lives behind the row's `···` menu, exactly as it does in the OSS 市场.
 *  The menu is portaled to the page, so its item is no descendant of the row;
 *  one menu is open at a time. */
async function uninstallOrgPlugin(page: Page, name: string): Promise<void> {
  await orgCard(page, name).getByTestId('enterprise-plugin-menu').click();
  await page.getByTestId('enterprise-plugin-menu-uninstall').click();
}

/** Force a catalog re-sync: the tab polls every 5 min, but re-syncs on mount.
 *  Leaving for 「我的」 unmounts it; coming back remounts it. */
async function resyncOrgCatalog(page: Page): Promise<void> {
  await selectSource(page, 'mine');
  await selectSource(page, 'market');
}

// ─── the walkthrough ─────────────────────────────────────────────────────────

test.describe.serial('organization plugin install loop (real shell + real console)', () => {
  test.skip(
    LOGIN_FIXTURE === '',
    'run with the opt-in private organization fixture runner',
  );

  let dataRoot: ElectronDataRoot;
  let app: ElectronApplication;
  let page: Page;
  let catalogEntry: CatalogEntry;
  let fixture: UnsignedFixture;
  let CATALOG_PLUGIN: string;
  let OWNED_PLUGIN: string;

  test.beforeAll(async () => {
    const module = await import(pathToFileURL(LOGIN_FIXTURE).href);
    fixture = module.createUnsignedPluginFixture();
    CATALOG_PLUGIN = fixture.catalogName;
    OWNED_PLUGIN = fixture.ownedName;
    catalogEntry = await fixture.prepare();

    const launched = await launchAbuElectron();
    dataRoot = launched;
    app = launched.app;
    page = await app.firstWindow();
    await waitForWelcomeScreen(page);
    await dismissFirstRunOverlays(page);
    await fixture.bindToConsole(app, page);
  });

  test.afterAll(async () => {
    try {
      if (app) await closeAbuElectron(app);
    } finally {
      try {
        if (dataRoot) removeElectronDataRoot(dataRoot);
      } finally {
        if (fixture) await fixture.cleanup();
      }
    }
  });

  test('the bound shell renders the organization catalog as the 插件 「市场」', async () => {
    await openPluginsTab(page);

    // 「市场」 is the landing source, and for a bound client it is the console's
    // catalog rather than Abu's own market.
    await expect(sourceTab(page, 'market')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('main').getByText(CATALOG_PLUGIN).first()).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    // 「我的」 is the other half of the same tab and stays personal: the
    // organization catalog must not be what it shows.
    await selectSource(page, 'mine');
    await expect(page.getByTestId('plugin-mine-row').filter({ hasText: CATALOG_PLUGIN })).toHaveCount(0);
    await selectSource(page, 'market');
  });

  test('the catalog row states the disclosure counts and the 组织审核 badge', async () => {
    // What the console published — the row must be a faithful rendering of it.
    expect(catalogEntry.disclosure.skills).toEqual(['prd-doctor']);
    expect(catalogEntry.disclosure.mcpServers).toEqual([]);

    const card = orgCard(page, CATALOG_PLUGIN);
    await expect(card).toContainText(
      `${catalogEntry.disclosure.skills.length} 个技能 · ${catalogEntry.disclosure.mcpServers.length} 个连接器`,
    );
    await expect(card).toContainText(`最新 v${catalogEntry.latestVersion}`);
    await expect(card).toContainText(BADGE_REVIEWED);
  });

  test('cancelling the disclosure installs nothing and leaves no staging tree', async () => {
    await orgCard(page, CATALOG_PLUGIN).getByRole('button', { name: ACTION_INSTALL }).click();

    const disclosure = page.getByTestId('plugin-install-disclosure');
    await expect(disclosure).toBeVisible({ timeout: INSTALL_TIMEOUT });
    // The confirm button only exists in the `ready` state, so waiting on it is
    // what proves the download + verify + plan actually completed — and the
    // 取消 button only replaces 关闭 there too.
    await expect(page.getByTestId('plugin-install-confirm')).toBeVisible({ timeout: INSTALL_TIMEOUT });
    await expect(page.getByTestId('plugin-disclosure-unsigned')).toBeVisible();
    await expect(disclosure.getByText('prd-doctor', { exact: true })).toBeVisible();
    await disclosure.getByRole('button', { name: CANCEL_BUTTON }).click();
    await expect(disclosure).toBeHidden({ timeout: READY_TIMEOUT });

    // A cancel must undo the download it already staged: no install record, and
    // — the invariant that broke before — no orphaned third-party tree left
    // under $HOME with nobody holding its path.
    expect(installedRecord(dataRoot, CATALOG_PLUGIN)).toBeUndefined();
    await expect
      .poll(() => fs.existsSync(path.join(stagingRoot(dataRoot), CATALOG_PLUGIN)), {
        timeout: READY_TIMEOUT,
      })
      .toBe(false);
    // The card is unchanged: still offered for install, still not installed.
    await expect(orgCard(page, CATALOG_PLUGIN)).toContainText(BADGE_REVIEWED);
  });

  test('installing writes the documented on-disk layout and clears staging', async () => {
    await orgCard(page, CATALOG_PLUGIN).getByRole('button', { name: ACTION_INSTALL }).click();

    const disclosure = page.getByTestId('plugin-install-disclosure');
    await expect(disclosure).toBeVisible({ timeout: INSTALL_TIMEOUT });
    await expect(page.getByTestId('plugin-install-confirm')).toBeVisible({ timeout: INSTALL_TIMEOUT });
    // The disclosure names the skill the package will contribute, and declares
    // no connector — the same two facts the catalog row summarised as counts.
    await expect(page.getByTestId('plugin-disclosure-unsigned')).toBeVisible();
    await expect(disclosure.getByText('prd-doctor', { exact: true })).toBeVisible();
    await expect(page.getByTestId('plugin-disclosure-server')).toHaveCount(0);
    await page.getByTestId('plugin-install-confirm').click();
    await expect(disclosure).toBeHidden({ timeout: INSTALL_TIMEOUT });

    // ── on real disk, literal paths ───────────────────────────────────────
    const version = catalogEntry.latestVersion;
    const packageDir = path.join(enterpriseRoot(dataRoot), CATALOG_PLUGIN, version);
    const manifestPath = path.join(packageDir, '.abu-plugin', 'plugin.json');
    const skillPath = path.join(packageDir, 'skills', 'prd-doctor', 'SKILL.md');

    // Poll the WHOLE postcondition: the copy lands file by file and this probe
    // watches it from outside the process, so waiting on the manifest alone can
    // resolve mid-copy.
    await expect
      .poll(() => fs.existsSync(manifestPath) && fs.existsSync(skillPath), { timeout: INSTALL_TIMEOUT })
      .toBe(true);

    // The manifest survived the copy intact (dot-directory and all) and still
    // describes this package.
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name: string; version: string };
    expect(manifest.name).toBe(CATALOG_PLUGIN);
    expect(manifest.version).toBe(version);

    // installed.json records it as an ENTERPRISE install, checksummed with the
    // catalog's own sha256 — that equality is what the 已安装 / 可更新 badge
    // and the whole update path are computed from.
    const record = installedRecord(dataRoot, CATALOG_PLUGIN);
    expect(record).toBeDefined();
    expect(record?.marketplace).toBe('enterprise');
    expect(record?.version).toBe(version);
    expect(record?.checksum).toBe(catalogEntry.sha256);
    expect(record?.key).toBe(`${CATALOG_PLUGIN}@enterprise`);
    expect(record?.contributed.skills.length).toBeGreaterThan(0);

    // The staging tree is a sibling of the installed packages and is removed
    // once the commit copied out of it — nothing unreviewed is left under $HOME.
    await expect
      .poll(() => stagedEntries(dataRoot), { timeout: INSTALL_TIMEOUT })
      .toEqual([]);
    expect(fs.existsSync(path.join(stagingRoot(dataRoot), CATALOG_PLUGIN))).toBe(false);
  });

  test('the card reads 已安装 and 「我的」 does not list it', async () => {
    await expect(orgCard(page, CATALOG_PLUGIN)).toContainText(BADGE_INSTALLED, { timeout: READY_TIMEOUT });

    // 「我的」 lists what this user wrote. An organization install is not that,
    // so it must not appear there — the row asserted absent here is the same
    // `plugin-mine-row` the personal spec asserts PRESENT for a self-authored
    // plugin, so an implementation that simply rendered nothing would fail
    // that spec rather than pass this one.
    await selectSource(page, 'mine');
    await expect(page.getByTestId('plugin-mine-row').filter({ hasText: CATALOG_PLUGIN })).toHaveCount(0);

    await selectSource(page, 'market');
  });

  test('uninstalling from the 「市场」 card removes the record and the installed version', async () => {
    const packageRoot = path.join(enterpriseRoot(dataRoot), CATALOG_PLUGIN);
    expect(fs.existsSync(packageRoot)).toBe(true);

    await uninstallOrgPlugin(page, CATALOG_PLUGIN);

    await expect
      .poll(() => fs.existsSync(path.join(packageRoot, catalogEntry.latestVersion)), { timeout: INSTALL_TIMEOUT })
      .toBe(false);
    expectRetiredVersions(packageRoot, CATALOG_PLUGIN, [catalogEntry.latestVersion]);
    await expect
      .poll(() => installedRecord(dataRoot, CATALOG_PLUGIN) === undefined, { timeout: INSTALL_TIMEOUT })
      .toBe(true);
    await expect(orgCard(page, CATALOG_PLUGIN)).toContainText(BADGE_REVIEWED, { timeout: READY_TIMEOUT });
    await expect(orgCard(page, CATALOG_PLUGIN).getByRole('button', { name: ACTION_INSTALL })).toBeVisible();
    await expect(orgCard(page, CATALOG_PLUGIN).getByRole('button', { name: ACTION_INSTALL })).toBeEnabled();
    expect(stagedEntries(dataRoot)).toEqual([]);
  });

  test('a newly published version shows 可更新 and 更新 swaps the version directory', async () => {
    // Install the spec-owned first version — the update path needs something to
    // update, and using its own package keeps the administrator's catalog
    // untouched (see OWNED_PLUGIN).
    await expect(orgCard(page, OWNED_PLUGIN)).toContainText(BADGE_REVIEWED, { timeout: READY_TIMEOUT });
    await orgCard(page, OWNED_PLUGIN).getByRole('button', { name: ACTION_INSTALL }).click();
    await expect(page.getByTestId('plugin-install-confirm')).toBeVisible({ timeout: INSTALL_TIMEOUT });
    await page.getByTestId('plugin-install-confirm').click();
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden({ timeout: INSTALL_TIMEOUT });

    const oldDir = path.join(enterpriseRoot(dataRoot), OWNED_PLUGIN, fixture.firstVersion);
    await expect
      .poll(() => fs.existsSync(path.join(oldDir, '.abu-plugin', 'plugin.json')), { timeout: INSTALL_TIMEOUT })
      .toBe(true);

    // Publish the next version to the real console, then make the tab re-poll.
    await fixture.publishUpdate();
    await resyncOrgCatalog(page);

    await expect(orgCard(page, OWNED_PLUGIN)).toContainText(BADGE_UPDATABLE, { timeout: INSTALL_TIMEOUT });
    await orgCard(page, OWNED_PLUGIN).getByRole('button', { name: ACTION_UPDATE }).click();
    await expect(page.getByTestId('plugin-install-confirm')).toBeVisible({ timeout: INSTALL_TIMEOUT });
    await page.getByTestId('plugin-install-confirm').click();
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden({ timeout: INSTALL_TIMEOUT });

    // The new version is on disk, the old one is gone — an update must not
    // leave the record and the tree straddling two versions.
    const newDir = path.join(enterpriseRoot(dataRoot), OWNED_PLUGIN, fixture.nextVersion);
    await expect
      .poll(() => fs.existsSync(path.join(newDir, '.abu-plugin', 'plugin.json')), { timeout: INSTALL_TIMEOUT })
      .toBe(true);
    await expect.poll(() => fs.existsSync(oldDir), { timeout: INSTALL_TIMEOUT }).toBe(false);
    await expect
      .poll(() => installedRecord(dataRoot, OWNED_PLUGIN)?.version, { timeout: INSTALL_TIMEOUT })
      .toBe(fixture.nextVersion);
    // …and the update, like the install, cleaned its staging tree up.
    await expect.poll(() => stagedEntries(dataRoot), { timeout: INSTALL_TIMEOUT }).toEqual([]);

    // Leave the isolated home clean for the teardown.
    await uninstallOrgPlugin(page, OWNED_PLUGIN);
    await expect
      .poll(() => fs.existsSync(newDir), { timeout: INSTALL_TIMEOUT })
      .toBe(false);
    expectRetiredVersions(path.join(enterpriseRoot(dataRoot), OWNED_PLUGIN), OWNED_PLUGIN,
      [fixture.firstVersion, fixture.nextVersion]);
    await expect.poll(() => installedRecord(dataRoot, OWNED_PLUGIN), { timeout: INSTALL_TIMEOUT }).toBeUndefined();
    await expect(orgCard(page, OWNED_PLUGIN)).toContainText(BADGE_REVIEWED);
    await expect(orgCard(page, OWNED_PLUGIN).getByRole('button', { name: ACTION_INSTALL })).toBeVisible();
    await expect(orgCard(page, OWNED_PLUGIN).getByRole('button', { name: ACTION_INSTALL })).toBeEnabled();
    expect(stagedEntries(dataRoot)).toEqual([]);
  });
});
