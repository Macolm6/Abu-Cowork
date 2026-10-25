/**
 * Apps (product brief stories 1–3): the switcher, adding a market folder and
 * an app from it together with the plugin it needs, the app's home, a
 * conversation bound to it, the `url:` page, persistence across a restart, a
 * scene whose plugin was uninstalled, and removing the app. Runs the real
 * Electron shell with the example market shipped in `examples/plugin-market/`,
 * a loopback mock LLM (to read the system prompt the app injects) and a
 * loopback page server (to stand in for the app's web page).
 */
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  REPO_ROOT,
  closeAbuElectron,
  configureLocalMockProvider,
  dismissFirstRunOverlays,
  launchAbuElectron,
  pressWhenSettled,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const APP_NAME = '店铺运营';
const APP_ID = 'shop-ops@abu-examples';
const PLUGIN_NAME = 'shop-assistant';
const EXPLICIT_TEAM_REQUEST = 'E2E-EXPLICIT-TEAM-ROUTE';
const EXTENSIONS = /^(扩展|Extensions)(\s.*)?$/;
const TEAM_NAV = /^(专家|Experts)$/;
const NEW_TASK = /^(新任务|New task)$/;
const AUTOMATION = /^(自动化|Automation)$/;

interface MockRequest { system: string; user: string }

function sse(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'chatcmpl-abu-e2e-app', object: 'chat.completion.chunk', created: 0, model: 'abu-e2e-local-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return chunk({ content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
}

function delegateSse(): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'chatcmpl-abu-e2e-app', object: 'chat.completion.chunk', created: 0, model: 'abu-e2e-local-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return chunk({ tool_calls: [{
    index: 0, id: 'call-app-explicit-team', type: 'function',
    function: { name: 'delegate_to_agent', arguments: JSON.stringify({ agent_name: '数据分析师', task: `Read the supplied request and reply with its marker: ${EXPLICIT_TEAM_REQUEST}` }) },
  }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
}

/** Loopback OpenAI-compatible mock: answers every task with one line and records the prompts. */
async function startLlmMock(): Promise<{ baseUrl: string; requests: MockRequest[]; close: () => Promise<void> }> {
  const requests: MockRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as {
      messages?: Array<{ role: string; content: unknown }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const messages = body.messages ?? [];
    const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    const user = messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const background = system.includes('你是一个记忆提取助手') || user.includes('请将以下对话内容压缩为一段简洁的摘要');
    if (!background) requests.push({ system, user });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const canDelegate = body.tools?.some((tool) => tool.function?.name === 'delegate_to_agent') === true;
    const hasToolResult = messages.some((message) => message.role === 'tool');
    res.end(!background && user.includes(EXPLICIT_TEAM_REQUEST) && canDelegate && !hasToolResult
      ? delegateSse()
      : sse(background ? '[]' : 'Abu E2E app reply.'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://2130706433:${port}/v1`, requests, close: () => closeServer(server) };
}

/** The app's "web page": a loopback origin the app copy is rewritten to allow. */
async function startPageServer(): Promise<{ origin: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '/');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Portal</title><h1 id="portal">Shop portal</h1><a id="outside" href="https://example.org/outside">outside</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, hits, close: () => closeServer(server) };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** A private copy of the example market, the app's page pointed at the loopback server. */
function seedExampleMarket(pageOrigin: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-e2e-app-market-'));
  fs.cpSync(path.join(REPO_ROOT, 'examples', 'plugin-market'), dir, { recursive: true });
  const appPath = path.join(dir, 'apps', 'shop-ops', '.abu-app', 'app.json');
  const appFile = JSON.parse(fs.readFileSync(appPath, 'utf8')) as { allowedOrigins: string[]; nav: { items: Array<{ id: string; target: string }> } };
  appFile.allowedOrigins = [pageOrigin];
  for (const item of appFile.nav.items) if (item.id === 'portal') item.target = `url:${pageOrigin}/portal`;
  fs.writeFileSync(appPath, JSON.stringify(appFile, null, 2));
  return dir;
}

async function openSwitcher(page: Page): Promise<void> {
  await page.getByTestId('app-switcher-trigger').click();
  await expect(page.getByTestId('app-switcher-menu')).toBeVisible();
}

/** Sending the first message of a conversation collapses the sidebar; the switcher and the navigation live there. */
async function showSidebar(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^(显示侧栏|Show sidebar)$/ });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.getByTestId('app-switcher-trigger')).toBeVisible();
}

async function openPlugins(page: Page): Promise<void> {
  await showSidebar(page);
  await page.getByLabel('Main navigation').getByRole('button', { name: EXTENSIONS }).click();
  await page.getByRole('main').getByRole('button', { name: /^(插件|Plugins)(\s.*)?$/ }).click();
  await page.getByTestId('extensions-source-mine').click();
}

test.describe.serial('apps', () => {
  let dataRoot: ElectronDataRoot;
  let app: ElectronApplication;
  let page: Page;
  let marketDir: string;
  let llm: Awaited<ReturnType<typeof startLlmMock>>;
  let pages: Awaited<ReturnType<typeof startPageServer>>;

  test.beforeAll(async () => {
    llm = await startLlmMock();
    pages = await startPageServer();
    marketDir = seedExampleMarket(pages.origin);
    const launched = await launchAbuElectron();
    dataRoot = launched;
    app = launched.app;
    page = await app.firstWindow();
    await expect(page.getByLabel('Main navigation')).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page, { apps: true });
    await configureLocalMockProvider(page, llm.baseUrl, { supportsTools: true });
  });

  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
    if (marketDir) fs.rmSync(marketDir, { recursive: true, force: true });
    await llm?.close();
    await pages?.close();
  });

  test('a fresh install keeps Abu\'s name and offers 发现应用 beside it', async () => {
    await expect(page.getByTestId('app-switcher-current')).toHaveText(/发现应用|Discover apps/);
    await openSwitcher(page);
    await expect(page.getByTestId('app-switcher-item-__general__')).toHaveCount(0);
    await expect(page.getByTestId('app-switcher-discover')).toBeVisible();
    await expect(page.getByTestId('app-switcher-create')).toBeVisible();
    await expect(page.getByTestId('app-switcher-empty')).toHaveText('暂无应用');
    await app.evaluate(({ shell }) => {
      const fixture = globalThis as typeof globalThis & { appDocsOpened: string[]; restoreAppDocsOpen: () => void };
      const originalOpen = shell.openExternal;
      fixture.appDocsOpened = [];
      fixture.restoreAppDocsOpen = () => { shell.openExternal = originalOpen; };
      shell.openExternal = async (url) => { fixture.appDocsOpened.push(url); };
    });
    await page.getByRole('menuitem', { name: '开发文档', exact: true }).click();
    await expect(page.getByTestId('app-switcher-menu')).toBeHidden();
    await expect.poll(() => app.evaluate(() => (
      globalThis as typeof globalThis & { appDocsOpened: string[] }
    ).appDocsOpened)).toEqual(['https://abuwork.com/platform.html']);
    await app.evaluate(() => (globalThis as typeof globalThis & { restoreAppDocsOpen: () => void }).restoreAppDocsOpen());
    await expect(page.getByTestId('app-switcher-menu')).toBeHidden();
  });

  test('查看更多 opens the app market; 使用 adds the plugin it needs with the app and enters it', async () => {
    await openSwitcher(page);
    await page.getByTestId('app-switcher-discover').click();
    const market = page.getByTestId('app-market-dialog');
    await expect(market).toBeVisible({ timeout: READY_TIMEOUT });
    // The official market's own apps are there before anything is added.
    await expect(market.locator('[data-testid="app-market-entry"][data-app-id="ecommerce@abu-official"]')).toBeVisible({ timeout: READY_TIMEOUT });

    await market.getByTestId('app-market-add-market').click();
    await page.getByTestId('plugin-marketplace-dir-input').fill(marketDir);
    await page.getByTestId('plugin-marketplace-submit').click();
    await expect(market.getByTestId('app-market-market')).toContainText('abu-examples', { timeout: READY_TIMEOUT });
    const entry = market.locator(`[data-testid="app-market-entry"][data-app-id="${APP_ID}"]`);
    await expect(entry).toContainText(APP_NAME);
    await entry.getByTestId('app-market-use').click();

    // The plugin it needs comes along, shown the way a plugin install shows it;
    // the page the app opens is listed as well.
    const dialog = page.getByTestId('app-add-dialog');
    await expect(dialog).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(dialog.getByTestId('app-add-plugin')).toHaveAttribute('data-plugin', 'shop-assistant');
    await expect(dialog.getByTestId('plugin-disclosure-team')).toContainText('店铺运营小组');
    await expect(dialog.getByTestId('app-add-sites')).toContainText(pages.origin);
    // The shop connector reads `${config.SHOP_TOKEN}`; adding waits for that value.
    await expect(dialog.getByTestId('app-add-confirm')).toBeDisabled();
    await dialog.getByLabel('SHOP_TOKEN', { exact: true }).fill('e2e-shop-token-placeholder');
    await dialog.getByTestId('app-add-confirm').click();

    // Straight into the app: switcher, home title, Abu's entries and then the app's page.
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(market).toBeHidden();
    await expect(page.getByTestId('app-home-title')).toHaveText(APP_NAME);
    await openSwitcher(page);
    await expect(page.getByTestId('app-switcher-empty')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('sidebar-app-page-portal')).toBeVisible();
    await expect(page.getByLabel('Main navigation').getByRole('button')).toHaveText([NEW_TASK, TEAM_NAV, EXTENSIONS, AUTOMATION, /^(店铺后台|Shop portal)$/]);
    await expect(page.getByTestId('app-connector-hint')).toContainText('shop-api');
    await page.getByTestId('app-connector-hint').getByRole('button', { name: /先不连接|Not now/ }).click();
    await expect(page.getByTestId('app-connector-hint')).toHaveCount(0);
  });

  test('cleared and edited input stays current when choosing templates and switching apps', async () => {
    await page.getByTestId('app-home-scene-shortlist').click();
    const composer = page.locator('[data-chat-composer]');
    const compare = page.getByTestId('app-home-template-compare');
    const trend = page.getByTestId('app-home-template-trend');
    const comparePrompt = '对比这三款候选商品的利润、竞争和季节性，给我一个推荐顺序';
    const trendPrompt = '分析这个品类最近三个月的趋势，判断现在进入是否合适';
    await compare.click();
    await expect(composer).toHaveValue(comparePrompt);
    await composer.fill('');
    await trend.click();
    await expect(composer).toHaveValue(trendPrompt);
    await expect.poll(() => page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('abu-composer-drafts') ?? '{}');
      return stored.state?.drafts?.['local:welcome']?.text ?? '';
    })).toBe(trendPrompt);

    await composer.fill('');
    await expect.poll(() => page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('abu-composer-drafts') ?? '{}');
      return stored.state?.drafts?.['local:welcome']?.text ?? '';
    })).toBe('');
    await compare.click();
    await expect(composer).toHaveValue(comparePrompt);
    await composer.fill('当前编辑内容');
    // The home hides its templates while the user has text in the composer.
    await expect(page.getByTestId('app-home-templates')).toBeHidden();
    await expect(composer).toHaveValue('当前编辑内容');

    await openSwitcher(page);
    await page.getByTestId('app-switcher-item-__general__').click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(/发现应用|Discover apps/);
    await expect(page.getByTestId('app-switcher-menu')).toBeHidden();
    await expect(composer).toHaveValue('当前编辑内容');
    await openSwitcher(page);
    await page.getByTestId(`app-switcher-item-${APP_ID}`).click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME);
    await expect(page.getByTestId('app-switcher-menu')).toBeHidden();
    await expect(composer).toHaveValue('当前编辑内容');
    await composer.fill('');
  });

  test('the home offers modes, scenes and templates; a template starts a conversation bound to the app', async () => {
    await page.getByTestId('app-home-mode-listing').click();
    await expect(page.getByTestId('app-home-mode-listing')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('app-home-scene-write-listing').click();
    await expect(page.getByTestId('app-home-templates')).toBeVisible();
    const ordered = await page.evaluate(() => {
      const selectors = ['[data-testid="app-home-modes"]', '[data-testid="app-home-scenes"]', '[data-testid="app-home-templates"]', '[data-chat-composer]'];
      const boxes = selectors.map((selector) => document.querySelector(selector)!.getBoundingClientRect());
      return boxes.every((box, index) => index === 0 || boxes[index - 1].bottom <= box.top);
    });
    expect(ordered).toBe(true);
    await expect(page.getByTestId('app-home').getByTestId('app-logo')).toHaveCSS('width', '56px');
    const logoImage = page.getByTestId('app-home').getByTestId('app-logo').locator('img');
    await expect(logoImage).toBeVisible();
    await expect.poll(() => logoImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.getByTestId('app-home-template-rewrite').click();
    const composer = page.locator('[data-chat-composer]');
    const composerText = () => composer.evaluate((element) => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '');
    await expect(composer).toBeVisible();
    await expect.poll(composerText).toMatch(/改成三个更吸引点击的版本/);
    // The scene runs the product-listing skill: the composer carries the skill chip.
    await expect(page.getByRole('button', { name: '/product-listing', exact: true })).toBeVisible();
    expect(llm.requests).toHaveLength(0);

    await composer.click();
    await composer.press('End');
    await composer.pressSequentially(' Keep the brand name.');
    await composer.press('Enter');
    await expect.poll(() => llm.requests.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(0);
    const [request] = llm.requests;
    expect(request.user).toContain('Keep the brand name.');
    expect(request.system).toContain('## App Context');
    expect(request.system).toContain(`inside the app "${APP_NAME}"`);
    expect(request.system).toContain('<app-instructions>');
    expect(request.system).toContain('The user runs an online shop.');
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('conversation-app-icon')).toHaveCount(1);
  });

  test('typing straight into the composer runs on the team the app names', async () => {
    await showSidebar(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: NEW_TASK }).click();
    await expect(page.getByTestId('app-home-title')).toBeVisible();
    const before = llm.requests.length;
    const composer = page.locator('[data-chat-composer]');
    await composer.click();
    await page.keyboard.type('上个月哪些商品退货最多？');
    await composer.press('Enter');
    await expect.poll(() => llm.requests.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(before);
    await expect(page.getByTestId('chat-title-team-badge')).toContainText('店铺运营小组', { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME);
  });

  test('新任务 pressed again with the home in view: the next conversation is still the app\'s, on its team', async () => {
    await showSidebar(page);
    const newTask = page.getByLabel('Main navigation').getByRole('button', { name: NEW_TASK });
    await newTask.click();
    await expect(page.getByTestId('app-home-title')).toHaveText(APP_NAME);
    await expect(page.getByTestId('composer-team-chip')).toContainText('店铺运营小组');
    await newTask.click();
    await expect(page.getByTestId('app-home-title')).toHaveText(APP_NAME);
    await expect(page.getByTestId('composer-team-chip')).toContainText('店铺运营小组');

    const boundBefore = await page.getByTestId('conversation-app-icon').count();
    const before = llm.requests.length;
    const composer = page.locator('[data-chat-composer]');
    await composer.click();
    await page.keyboard.type('这个月的差评集中在哪些商品？');
    await composer.press('Enter');
    await expect.poll(() => llm.requests.slice(before).some((request) => request.system.includes(`inside the app "${APP_NAME}"`)), { timeout: READY_TIMEOUT }).toBe(true);
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('chat-title-team-badge')).toContainText('店铺运营小组');
    await showSidebar(page);
    await expect(page.getByTestId('conversation-app-icon')).toHaveCount(boundBefore + 1);
  });

  test('创建应用 chosen inside the app opens a conversation of the general shell; the app keeps its own conversations', async () => {
    await showSidebar(page);
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME);
    const boundBefore = await page.getByTestId('conversation-app-icon').count();
    await openSwitcher(page);
    await page.getByTestId('app-switcher-create').click();

    // The general shell, on the creation conversation, which carries no app.
    await expect(page.getByTestId('app-switcher-current')).toHaveText(/发现应用|Discover apps/, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('sidebar-app-page-portal')).toHaveCount(0);
    const composer = page.locator('[data-chat-composer]');
    await expect(composer).toBeVisible();
    await expect(page.getByRole('button', { name: '/abu-app-builder', exact: true })).toBeVisible();
    await expect(page.getByTestId('chat-title-app-badge')).toHaveCount(0);
    await expect(page.getByTestId('chat-title-team-badge')).toHaveCount(0);
    await expect(page.getByTestId('app-home-title')).toHaveCount(0);
    await expect(page.getByTestId('conversation-app-icon')).toHaveCount(boundBefore);

    // Back in the app, a conversation started there is bound to it as before.
    await openSwitcher(page);
    await page.getByTestId(`app-switcher-item-${APP_ID}`).click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME);
    await expect(page.getByTestId('app-home-title')).toHaveText(APP_NAME);
    const before = llm.requests.length;
    const homeComposer = page.locator('[data-chat-composer]');
    await homeComposer.click();
    await page.keyboard.type('这周的订单有什么要注意的？');
    await homeComposer.press('Enter');
    await expect.poll(() => llm.requests.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(before);
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('conversation-app-icon')).toHaveCount(boundBefore + 1);
  });

  test('创建插件 chosen inside the app opens a conversation of the general shell', async () => {
    // The app's home is in view and holds its binding and its team for the next conversation.
    await showSidebar(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: NEW_TASK }).click();
    await expect(page.getByTestId('app-home-title')).toHaveText(APP_NAME);
    await expect(page.getByTestId('composer-team-chip')).toContainText('店铺运营小组');
    const boundBefore = await page.getByTestId('conversation-app-icon').count();

    await openPlugins(page);
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME);
    await page.getByTestId('plugin-create-trigger').click();
    await page.getByTestId('plugin-create-menu').getByRole('menuitem', { name: /^(创建插件|Create plugin)$/ }).click();

    // The general shell, on the creation conversation, which carries no app and no team.
    await expect(page.getByRole('button', { name: '/abu-plugin-builder', exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId('app-switcher-current')).toHaveText(/发现应用|Discover apps/);
    await expect(page.getByTestId('sidebar-app-page-portal')).toHaveCount(0);
    await expect(page.locator('[data-chat-composer]')).toBeVisible();
    await expect(page.getByTestId('chat-title-app-badge')).toHaveCount(0);
    await expect(page.getByTestId('chat-title-team-badge')).toHaveCount(0);
    await expect(page.getByTestId('composer-team-chip')).toHaveCount(0);
    await expect(page.getByTestId('app-home-title')).toHaveCount(0);
    await expect(page.getByTestId('conversation-app-icon')).toHaveCount(boundBefore);

    await openSwitcher(page);
    await page.getByTestId(`app-switcher-item-${APP_ID}`).click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME);
    await expect(page.getByTestId('app-home-title')).toHaveText(APP_NAME);
  });

  test('the 专家 page opens on 本应用 and can widen to 全部', async () => {
    await showSidebar(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: TEAM_NAV }).click();
    // 本应用 | 全部 is one choice of two: each side is a radio, named by its words.
    const scope = page.getByTestId('team-app-scope');
    const thisApp = scope.getByRole('radio', { name: /^(本应用|This app)$/ });
    const everything = scope.getByRole('radio', { name: /^(全部|All)$/ });
    await expect(thisApp).toHaveAttribute('aria-checked', 'true');
    // The app's plugin experts sit on 市场; 本应用 keeps the shipped ones it does not use off it.
    await page.getByTestId('team-source-market').click();
    await expect(page.getByText('店铺客服顾问', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText('高级开发工程师', { exact: true })).toHaveCount(0);
    await everything.click();
    await expect(page.getByText('高级开发工程师', { exact: true })).toBeVisible();
    await thisApp.click();
    await expect(page.getByText('高级开发工程师', { exact: true })).toHaveCount(0);
    await page.getByTestId('top-tab-nav').getByRole('button', { name: '专家团', exact: true }).click();
    await page.getByTestId('team-source-market').click();
    await expect(page.getByTestId('team-row-汇报材料专家团')).toHaveCount(0);
    await everything.click();
    await expect(everything).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('team-row-汇报材料专家团')).toBeVisible();
    await page.getByLabel('Main navigation').getByRole('button', { name: NEW_TASK }).click();
  });

  test('the url: entry shows the app page in the main area and keeps it inside its origin', async () => {
    await page.getByTestId('sidebar-app-page-portal').click();
    await expect(page.getByTestId('app-page-view')).toHaveAttribute('data-nav-item', 'portal');
    await expect.poll(() => pages.hits.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(0);
    expect(pages.hits[0]).toBe('/portal');
    await page.getByLabel('Main navigation').getByRole('button', { name: NEW_TASK }).click();
    await expect(page.getByTestId('app-home-title')).toBeVisible();
    await expect(page.getByTestId('app-page-view')).toHaveCount(0);
  });

  test('starting with an expert from the app keeps that expert through sending', async () => {
    await showSidebar(page);
    await page.getByTestId('sidebar-team').click();
    await page.getByTestId('top-tab-nav').getByRole('button', { name: '专家', exact: true }).click();
    await page.getByTestId('team-source-market').click();
    await page.getByText('店铺客服顾问', { exact: true }).click();
    await page.getByRole('button', { name: '开始对话', exact: true }).click();
    await expect(page.getByTestId('app-home-title')).toHaveText(APP_NAME);
    await expect(page.getByRole('button', { name: '@店铺客服顾问', exact: true })).toBeVisible();
    await expect(page.getByTestId('composer-team-chip')).toHaveCount(0);
    const composer = page.locator('[data-chat-composer]');
    await composer.fill('帮我回复顾客关于退货的咨询');
    const before = llm.requests.length;
    await composer.press('Enter');
    await expect.poll(() => llm.requests.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(before);
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME);
    await expect(page.getByTestId('chat-title-team-badge')).toHaveCount(0);
  });

  for (const scope of ['app', 'general'] as const) test(`starting with a team in ${scope} preserves its identity and dispatches its member`, async () => {
    await showSidebar(page);
    if (scope === 'general') {
      await openSwitcher(page);
      await page.getByTestId('app-switcher-item-__general__').click();
    }
    await page.getByTestId('sidebar-team').click();
    if (scope === 'app') await page.getByTestId('team-app-scope').getByRole('radio', { name: '全部', exact: true }).click();
    await page.getByTestId('top-tab-nav').getByRole('button', { name: '专家团', exact: true }).click();
    await page.getByTestId('team-source-market').click();
    await page.getByTestId('team-row-汇报材料专家团').click();
    await page.getByTestId('team-detail-start-chat').click();
    await expect(page.getByTestId('composer-team-chip')).toContainText('汇报材料专家团');
    const composer = page.locator('[data-chat-composer]');
    await composer.fill(EXPLICIT_TEAM_REQUEST);
    const before = llm.requests.length;
    const conversationsBefore = await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('abu-chat') ?? '{}');
      return Object.keys(stored.state?.conversationIndex ?? {});
    });
    await composer.press('Enter');
    await expect.poll(() => llm.requests.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(before);
    await expect(page.getByTestId('chat-title-team-badge')).toContainText('汇报材料专家团');
    if (scope === 'app') await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME);
    else await expect(page.getByTestId('chat-title-app-badge')).toHaveCount(0);
    await expect.poll(() => llm.requests.slice(before).some((request) =>
      request.system.includes('You are a data analyst with 7 years of experience')
        && request.user.includes(EXPLICIT_TEAM_REQUEST)), { timeout: READY_TIMEOUT }).toBe(true);
    await expect(page.getByRole('button', { name: /^(停止|Stop)$/ })).toHaveCount(0, { timeout: READY_TIMEOUT });
    const created = await page.evaluate((previous) => {
      const stored = JSON.parse(localStorage.getItem('abu-chat') ?? '{}');
      return Object.entries(stored.state?.conversationIndex ?? {})
        .filter(([id]) => !previous.includes(id))
        .map(([, value]) => value) as Array<{ teamId?: string; appBinding?: { appId: string } }>;
    }, conversationsBefore);
    expect(created).toHaveLength(1);
    expect(created[0].teamId).toBe('builtin-team:reporting');
    if (scope === 'app') expect(created[0].appBinding?.appId).toBe(APP_ID);
    else {
      expect(created[0].appBinding).toBeUndefined();
      await showSidebar(page);
      await openSwitcher(page);
      await page.getByTestId(`app-switcher-item-${APP_ID}`).click();
    }
  });

  test('creating an app from an app home opens an independent creation conversation', async () => {
    await showSidebar(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: NEW_TASK }).click();
    await expect(page.getByTestId('composer-team-chip')).toContainText('店铺运营小组');
    await openSwitcher(page);
    await page.getByTestId('app-switcher-create').click();
    await expect(page.getByRole('button', { name: '/abu-app-builder', exact: true })).toBeVisible();
    await expect(page.getByTestId('composer-team-chip')).toHaveCount(0);
    await expect(page.getByTestId('chat-title-team-badge')).toHaveCount(0);
    await expect(page.getByTestId('chat-title-app-badge')).toHaveCount(0);
    await page.getByLabel('Main navigation').getByRole('button', { name: NEW_TASK }).click();
  });

  test('the selection survives a restart; 通用 returns to the general shell', async () => {
    await openSwitcher(page);
    await page.getByTestId(`app-switcher-item-${APP_ID}`).click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME);
    await closeAbuElectron(app);
    const relaunched = await launchAbuElectron(dataRoot);
    app = relaunched.app;
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: /^(显示侧栏|隐藏侧栏|Show sidebar|Hide sidebar)$/ })).toBeVisible({ timeout: READY_TIMEOUT });
    await showSidebar(page);
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('app-home-title')).toBeVisible({ timeout: READY_TIMEOUT });

    // The bound conversation reopens with its badge, whatever app is current.
    await page.getByTestId('conversation-app-icon').first().click();
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME, { timeout: READY_TIMEOUT });

    await openSwitcher(page);
    await page.getByTestId('app-switcher-item-__general__').click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(/发现应用|Discover apps/);
    await expect(page.getByTestId('sidebar-app-page-portal')).toHaveCount(0);
    await expect(page.getByLabel('Main navigation').getByRole('button', { name: /^(自动化|Automation)$/ })).toBeVisible();
    await openSwitcher(page);
    await expect(page.getByTestId('app-switcher-menu')).toContainText(/最近使用|Recent/);
    await page.getByTestId(`app-switcher-item-${APP_ID}`).click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME);
  });

  test('uninstalling the plugin it uses says so first; its scene then offers to install it again', async () => {
    await openPlugins(page);
    const row = page.getByTestId('plugin-mine-row').filter({ hasText: PLUGIN_NAME });
    await row.getByRole('button', { name: /^(卸载|Uninstall): / }).click();
    await expect(page.getByText(`应用 ${APP_NAME} 用到它`)).toBeVisible();
    await pressWhenSettled(page.getByRole('alertdialog').getByRole('button', { name: /^(卸载|Uninstall)$/ }));
    await expect(row).toHaveCount(0, { timeout: READY_TIMEOUT });

    // The app stays; the scene its team handles asks for the plugin back.
    await page.getByLabel('Main navigation').getByRole('button', { name: NEW_TASK }).click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME);
    await page.getByTestId('app-home-mode-sourcing').click();
    await page.getByTestId('app-home-scene-shortlist').click();
    await page.getByTestId('app-home-template-compare').click();
    const dialog = page.getByTestId('app-add-dialog');
    await expect(dialog.getByTestId('app-add-plugin')).toHaveAttribute('data-plugin', 'shop-assistant', { timeout: READY_TIMEOUT });
    await dialog.getByLabel('SHOP_TOKEN', { exact: true }).fill('e2e-shop-token-placeholder');
    await dialog.getByTestId('app-add-confirm').click();
    await expect(dialog).toBeHidden({ timeout: READY_TIMEOUT });
    const composer = page.locator('[data-chat-composer]');
    await expect.poll(() => composer.evaluate((element) => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '')).toMatch(/对比这三款候选商品/);
    await expect(page.getByTestId('composer-team-chip')).toContainText('店铺运营小组');
  });

  test('移除 takes only the app; its conversation stays readable and can add it back', async () => {
    await showSidebar(page);
    await openSwitcher(page);
    // 移除 is a list of its own in the switcher's menu; an app from a market is removed without a question.
    await page.getByTestId('app-switcher-remove').click();
    await page.getByTestId(`app-switcher-remove-${APP_ID}`).click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(/发现应用|Discover apps/, { timeout: READY_TIMEOUT });
    await openSwitcher(page);
    await expect(page.getByTestId(`app-switcher-item-${APP_ID}`)).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The plugin and its team are still installed.
    await openPlugins(page);
    await expect(page.getByTestId('plugin-mine-row').filter({ hasText: PLUGIN_NAME })).toHaveCount(1);
    await page.getByTestId('sidebar-team').click();
    await page.getByTestId('top-tab-nav').getByRole('button', { name: '专家团', exact: true }).click();
    await page.getByTestId('team-source-market').click();
    await expect(page.getByTestId('team-row-店铺运营小组')).toBeVisible();

    await page.getByTestId('conversation-app-icon').first().click();
    const notice = page.getByTestId('conversation-app-removed');
    await expect(notice).toContainText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME);
    await notice.getByRole('button', { name: /^(去添加|Add it)$/ }).click();
    await expect(page.getByTestId('app-market-dialog')).toBeVisible();
    const entry = page.locator(`[data-testid="app-market-entry"][data-app-id="${APP_ID}"]`);
    await entry.getByTestId('app-market-use').click();
    await page.getByTestId('app-add-confirm').click();
    await expect(page.getByTestId('app-market-dialog')).toBeHidden({ timeout: READY_TIMEOUT });
    await showSidebar(page);
    await page.getByTestId('conversation-app-icon').first().click();
    await expect(notice).toHaveCount(0);
    const before = llm.requests.length;
    await page.locator('[data-chat-composer]').fill('继续这次店铺咨询');
    await page.locator('[data-chat-composer]').press('Enter');
    await expect.poll(() => llm.requests.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(before);
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME);
  });
});
