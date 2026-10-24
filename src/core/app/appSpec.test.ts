import { describe, expect, it } from 'vitest';
import {
  APP_LIMITS,
  APPS_MIN_ABU_VERSION,
  appRuns,
  isAllowedAppPageOrigin,
  isAppName,
  parseAppConfig,
  parseAppFile,
  parseManagedAppConfig,
  resolveAppPageUrl,
  splitRunTarget,
} from '../../../electron/shared/appSpec.mjs';
import { PluginManifestError } from '../../../electron/shared/pluginManifestError.mjs';
import { BUILTIN_AGENT_NAMES } from '../../../electron/shared/pluginAgentFormat.mjs';

function templates(count = 3) {
  return Array.from({ length: count }, (_, i) => ({ id: `t${i}`, title: `T${i}`, prompt: `Prompt ${i}` }));
}

function scene(overrides: Record<string, unknown> = {}) {
  return { id: 'write-jd', title: '写 JD', run: { team: 'builtin-team:recruiting' }, templates: templates(), ...overrides };
}

function home(scenes: unknown[] = [scene()]) {
  return { modes: { items: [{ modeId: 'prepare', title: '岗位准备', scenes }] } };
}

function appFile(overrides: Record<string, unknown> = {}) {
  return {
    name: 'contract-review',
    version: '1.0.0',
    minAbuVersion: '0.51.0',
    interface: { displayName: '合同审阅', shortDescription: '按律所的做法审合同' },
    plugins: ['contract-tools'],
    home: home(),
    ...overrides,
  };
}

/** The field a failing parse reports, so a rule can be pinned by its path rather than its message. */
function failingField(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginManifestError);
    return (error as PluginManifestError).field;
  }
  throw new Error('expected a PluginManifestError');
}

const withRun = (run: unknown, overrides: Record<string, unknown> = {}) => appFile({ home: home([scene({ run })]), ...overrides });
const runField = 'home.modes.items[0].scenes[0].run';

describe('parseAppFile', () => {
  it('returns the app, its display fields, its plugins and its configuration', () => {
    const parsed = parseAppFile(appFile({ interface: { displayName: '合同审阅', shortDescription: '审合同', logo: 'assets/logo.png' } }));
    expect(parsed).toMatchObject({
      name: 'contract-review',
      version: '1.0.0',
      minAbuVersion: '0.51.0',
      plugins: ['contract-tools'],
      interface: { displayName: '合同审阅', shortDescription: '审合同', logo: 'assets/logo.png' },
    });
    expect(parsed.config.version).toBe(1);
    expect(parsed.config.home.modes.items[0].scenes[0].run).toEqual({ team: 'builtin-team:recruiting' });
  });

  it('takes the display name and the two descriptions per locale, and keeps a plain string as it is', () => {
    const plain = parseAppFile(appFile({ interface: { displayName: '合同审阅', shortDescription: '审合同', longDescription: '' } }));
    expect(plain.interface).toMatchObject({ displayName: '合同审阅', shortDescription: '审合同', longDescription: '' });

    const localized = parseAppFile(appFile({
      interface: {
        displayName: { 'zh-CN': '合同审阅', 'en-US': 'Contract Review' },
        shortDescription: { 'en-US': 'Review contracts the way the firm does' },
        longDescription: { 'zh-CN': '按律所的做法审合同，逐条给出修改意见。', 'en-US': 'Reviews a contract clause by clause.' },
      },
    }));
    expect(localized.interface.displayName).toEqual({ 'zh-CN': '合同审阅', 'en-US': 'Contract Review' });
    expect(localized.interface.shortDescription).toEqual({ 'en-US': 'Review contracts the way the firm does' });
    expect(localized.interface.longDescription).toEqual({ 'zh-CN': '按律所的做法审合同，逐条给出修改意见。', 'en-US': 'Reviews a contract clause by clause.' });
  });

  it('holds each locale of a display text to the length limit on its own', () => {
    const iface = (overrides: Record<string, unknown>) => appFile({ interface: { displayName: 'x', shortDescription: 'y', ...overrides } });
    expect(() => parseAppFile(iface({ displayName: { 'zh-CN': '名'.repeat(64), 'en-US': 'N'.repeat(64) } }))).not.toThrow();
    expect(failingField(() => parseAppFile(iface({ displayName: 'N'.repeat(65) })))).toBe('interface.displayName');
    expect(failingField(() => parseAppFile(iface({ displayName: { 'zh-CN': '合同审阅', 'en-US': 'N'.repeat(65) } })))).toBe('interface.displayName.en-US');
    expect(failingField(() => parseAppFile(iface({ shortDescription: { 'zh-CN': '介'.repeat(201), 'en-US': 'ok' } })))).toBe('interface.shortDescription.zh-CN');
    expect(() => parseAppFile(iface({ shortDescription: { 'zh-CN': '介'.repeat(200), 'en-US': 'd'.repeat(200) } }))).not.toThrow();
    expect(failingField(() => parseAppFile(iface({ longDescription: { 'en-US': 'd'.repeat(4001) } })))).toBe('interface.longDescription.en-US');
  });

  it('refuses a display text that is no string and no text per locale', () => {
    const iface = (overrides: Record<string, unknown>) => appFile({ interface: { displayName: 'x', shortDescription: 'y', ...overrides } });
    expect(failingField(() => parseAppFile(iface({ displayName: {} })))).toBe('interface.displayName');
    expect(failingField(() => parseAppFile(iface({ displayName: { 'fr-FR': 'Revue' } })))).toBe('interface.displayName.fr-FR');
    expect(failingField(() => parseAppFile(iface({ displayName: { 'en-US': ' ' } })))).toBe('interface.displayName.en-US');
    expect(failingField(() => parseAppFile(iface({ displayName: 42 })))).toBe('interface.displayName');
    expect(failingField(() => parseAppFile(iface({ displayName: ' ' })))).toBe('interface.displayName');
    expect(failingField(() => parseAppFile(iface({ shortDescription: ['a'] })))).toBe('interface.shortDescription');
  });

  it('checks the top-level fields', () => {
    expect(failingField(() => parseAppFile(appFile({ name: 'Contract Review' })))).toBe('name');
    expect(failingField(() => parseAppFile(appFile({ name: undefined })))).toBe('name');
    expect(failingField(() => parseAppFile(appFile({ version: '1.0' })))).toBe('version');
    expect(failingField(() => parseAppFile(appFile({ minAbuVersion: undefined })))).toBe('minAbuVersion');
    expect(failingField(() => parseAppFile(appFile({ minAbuVersion: '0.50.0' })))).toBe('minAbuVersion');
    expect(failingField(() => parseAppFile(appFile({ interface: { displayName: '合同审阅' } })))).toBe('interface.shortDescription');
    expect(failingField(() => parseAppFile(appFile({ interface: { displayName: 'x', shortDescription: 'y', brandColor: '#fff' } })))).toBe('interface.brandColor');
    expect(failingField(() => parseAppFile(appFile({ interface: { displayName: 'x', shortDescription: 'y', logo: '../logo.png' } })))).toBe('interface.logo');
    expect(failingField(() => parseAppFile(appFile({ plugins: ['a', 'a'] })))).toBe('plugins[1]');
    expect(failingField(() => parseAppFile(appFile({ plugins: ['tools@market'] })))).toBe('plugins[0]');
    expect(failingField(() => parseAppFile(appFile({ theme: 'dark' })))).toBe('theme');
    expect(failingField(() => parseAppFile([]))).toBe('.abu-app/app.json');
  });

  it('accepts a pre-release of the version apps arrived in', () => {
    expect(APPS_MIN_ABU_VERSION).toBe('0.51.0');
    expect(parseAppFile(appFile({ minAbuVersion: '0.51.0-rc.1' })).minAbuVersion).toBe('0.51.0-rc.1');
  });

  it('refuses to read an organization app as a file', () => {
    expect(() => parseAppFile(appFile(), { source: 'enterprise' as 'package' })).toThrow('organization apps are not app files');
  });
});

describe('run references', () => {
  it('accepts built-in and plugin targets in a packaged app', () => {
    const accepted = [
      { team: 'builtin-team:recruiting' },
      { expert: `builtin:${BUILTIN_AGENT_NAMES[1]}` },
      { team: 'plugin:contract-tools/review-team' },
      { expert: 'plugin:contract-tools/合同审阅员' },
      { skill: 'plugin:contract-tools/clause-check' },
      { team: 'plugin:contract-tools/review-team', skill: 'plugin:contract-tools/clause-check' },
    ];
    for (const run of accepted) expect(parseAppFile(withRun(run)).config.home.modes.items[0].scenes[0].run).toEqual(run);
  });

  it('keeps each source to its own references', () => {
    expect(failingField(() => parseAppFile(withRun({ expert: 'mine:周报助手' })))).toBe(`${runField}.expert`);
    expect(parseAppFile(withRun({ expert: 'mine:周报助手' }), { source: 'created' }).config.home.modes.items[0].scenes[0].run).toEqual({ expert: 'mine:周报助手' });
    expect(failingField(() => parseAppFile(withRun({ team: 'enterprise-team:abc' }), { source: 'created' }))).toBe(`${runField}.team`);
    const orgConfig = parseAppConfig({ home: home([scene({ run: { team: 'enterprise-team:abc', skill: 'enterprise:clause-check' } })]) }, { source: 'enterprise' });
    expect(orgConfig.home.modes.items[0].scenes[0].run).toEqual({ team: 'enterprise-team:abc', skill: 'enterprise:clause-check' });
    expect(failingField(() => parseAppConfig({ home: home([scene({ run: { team: 'builtin-team:recruiting' } })]) }, { source: 'enterprise', field: 'manifest' }))).toBe(`manifest.${runField}.team`);
  });

  it('reads an organization app configuration and refuses what an app file alone carries', () => {
    const config = parseManagedAppConfig({ home: home([scene({ run: { expert: 'enterprise-agent:abc' } })]) }, 'apps[0].manifest');
    expect(config.home.modes.items[0].scenes[0].run).toEqual({ expert: 'enterprise-agent:abc' });
    expect(failingField(() => parseManagedAppConfig({ home: home([scene()]), plugins: [] }, 'apps[0].manifest'))).toBe('apps[0].manifest.plugins');
    expect(failingField(() => parseManagedAppConfig('home', 'apps[0].manifest'))).toBe('apps[0].manifest');
  });

  it('reports the exact field for every broken reference', () => {
    expect(failingField(() => parseAppFile(withRun({ team: 'builtin-team:ghost' })))).toBe(`${runField}.team`);
    expect(failingField(() => parseAppFile(withRun({ expert: 'builtin:ghost' })))).toBe(`${runField}.expert`);
    expect(failingField(() => parseAppFile(withRun({ team: 'plugin:other-tools/review-team' })))).toBe(`${runField}.team`);
    expect(failingField(() => parseAppFile(withRun({ team: 'plugin:contract-tools/Review Team' })))).toBe(`${runField}.team`);
    expect(failingField(() => parseAppFile(withRun({ team: 'plugin:contract-tools/' })))).toBe(`${runField}.team`);
    expect(failingField(() => parseAppFile(withRun({ team: 'review-team' })))).toBe(`${runField}.team`);
    expect(failingField(() => parseAppFile(withRun({ skill: 'clause-check' })))).toBe(`${runField}.skill`);
    expect(failingField(() => parseAppFile(withRun({ team: 'builtin-team:recruiting', expert: `builtin:${BUILTIN_AGENT_NAMES[1]}` })))).toBe(runField);
    expect(failingField(() => parseAppFile(withRun({})))).toBe(runField);
    expect(failingField(() => parseAppFile(withRun({ crew: 'x' })))).toBe(`${runField}.crew`);
    expect(failingField(() => parseAppFile(appFile({ defaultRun: { team: 'ghost' } })))).toBe('defaultRun.team');
  });

  it('splits a target into where it comes from and what it names', () => {
    expect(splitRunTarget('team', 'builtin-team:recruiting')).toEqual({ origin: 'builtin', id: 'builtin-team:recruiting' });
    expect(splitRunTarget('expert', 'builtin:产品经理')).toEqual({ origin: 'builtin', id: '产品经理' });
    expect(splitRunTarget('team', 'plugin:shop/ops')).toEqual({ origin: 'plugin', plugin: 'shop', id: 'ops' });
    expect(splitRunTarget('expert', 'mine:周报助手')).toEqual({ origin: 'mine', id: '周报助手' });
    expect(splitRunTarget('expert', 'enterprise-agent:1234')).toEqual({ origin: 'enterprise', id: '1234' });
    expect(splitRunTarget('skill', 'enterprise:clause-check')).toEqual({ origin: 'enterprise', id: 'clause-check' });
    expect(splitRunTarget('team', 'plugin:shop')).toBeUndefined();
    expect(splitRunTarget('skill', 'mine:x')).toBeUndefined();
  });

  it('lists every run with its field, default first', () => {
    const parsed = parseAppFile(appFile({ defaultRun: { team: 'builtin-team:recruiting' } }));
    expect(appRuns(parsed.config).map((entry) => entry.field)).toEqual(['defaultRun', runField]);
    expect(appRuns(parsed.config)[1]).toMatchObject({ modeId: 'prepare', sceneId: 'write-jd' });
  });
});

describe('home', () => {
  it('checks modes, scenes and template counts', () => {
    expect(failingField(() => parseAppFile(appFile({ home: { modes: { items: [] } } })))).toBe('home.modes.items');
    expect(failingField(() => parseAppFile(appFile({ home: home([]) })))).toBe('home.modes.items[0].scenes');
    expect(failingField(() => parseAppFile(appFile({ home: home([scene({ templates: templates(2) })]) })))).toBe('home.modes.items[0].scenes[0].templates');
    expect(failingField(() => parseAppFile(appFile({ home: home([scene({ templates: templates(APP_LIMITS.templatesMax + 1) })]) })))).toBe('home.modes.items[0].scenes[0].templates');
    expect(failingField(() => parseAppFile(appFile({ home: { modes: { defaultSelected: 'nope', items: home().modes.items } } })))).toBe('home.modes.defaultSelected');
  });

  it('rejects duplicate ids at every level', () => {
    const mode = { modeId: 'a', title: 'A', scenes: [scene()] };
    expect(failingField(() => parseAppFile(appFile({ home: { modes: { items: [mode, mode] } } })))).toBe('home.modes.items[1]');
    expect(failingField(() => parseAppFile(appFile({ home: home([scene(), scene()]) })))).toBe('home.modes.items[0].scenes[1]');
    const duplicated = [...templates(2), { id: 't0', title: 'dup', prompt: 'dup' }];
    expect(failingField(() => parseAppFile(appFile({ home: home([scene({ templates: duplicated })]) })))).toBe('home.modes.items[0].scenes[0].templates[2]');
  });

  it('checks promptAppend length, the composer and requiredConnectors', () => {
    expect(failingField(() => parseAppFile(appFile({ promptAppend: 'x'.repeat(APP_LIMITS.promptAppend + 1) })))).toBe('promptAppend');
    expect(failingField(() => parseAppFile(appFile({ composer: { placeholder: '' } })))).toBe('composer.placeholder');
    expect(parseAppFile(appFile({ requiredConnectors: ['contract-tools/crm'] })).config.requiredConnectors).toEqual(['contract-tools/crm']);
    expect(failingField(() => parseAppFile(appFile({ requiredConnectors: ['crm'] })))).toBe('requiredConnectors[0]');
    expect(failingField(() => parseAppFile(appFile({ requiredConnectors: ['other/crm'] })))).toBe('requiredConnectors[0]');
  });
});

describe('nav and pages', () => {
  const page = { id: 'portal', title: '门户', target: 'url:https://portal.example.com/home?x=1' };
  const origins = { allowedOrigins: ['https://portal.example.com'] };

  // Abu's own entries are always shown; an app's navigation lists its web pages only.
  it('takes the app\'s own pages only, at least one, with unique ids', () => {
    expect(failingField(() => parseAppFile(appFile({ nav: { items: [] } })))).toBe('nav.items');
    for (const target of ['builtin:chat', 'builtin:team', 'builtin:settings']) {
      expect(failingField(() => parseAppFile(appFile({ ...origins, nav: { items: [page, { id: 'x', target }] } })))).toBe('nav.items[1].target');
    }
    expect(failingField(() => parseAppFile(appFile({ ...origins, nav: { items: [page, { ...page }] } })))).toBe('nav.items[1]');
  });

  it('binds url: targets to allowedOrigins and requires a title', () => {
    expect(failingField(() => parseAppFile(appFile({ nav: { items: [page] } })))).toBe('nav.items[0].target');
    expect(failingField(() => parseAppFile(appFile({ nav: { items: [page] }, allowedOrigins: ['https://other.example.com'] })))).toBe('nav.items[0].target');
    expect(failingField(() => parseAppFile(appFile({ ...origins, nav: { items: [{ ...page, title: undefined }] } })))).toBe('nav.items[0].title');
    // `blob:` and `filesystem:` take their origin from the address inside
    // them, so an origin comparison alone would let one through while the
    // page it names is something else entirely.
    for (const scheme of ['blob:https://portal.example.com/x', 'filesystem:https://portal.example.com/temporary/x']) {
      expect(failingField(() => parseAppFile(appFile({ ...origins, nav: { items: [{ ...page, target: `url:${scheme}` }] } })))).toBe('nav.items[0].target');
    }
    const parsed = parseAppFile(appFile({ ...origins, nav: { items: [page] } }));
    expect(resolveAppPageUrl(parsed.config, 'portal')).toBe('https://portal.example.com/home?x=1');
    // The host loads whatever `resolveAppPageUrl` returns, so it settles the
    // scheme itself rather than trusting the config it was handed.
    const forged = { ...parsed.config, nav: { items: [{ id: 'portal', target: 'url:blob:https://portal.example.com/x' as const }] } };
    expect(failingField(() => resolveAppPageUrl(forged, 'portal'))).toBe('nav.items');
    expect(failingField(() => resolveAppPageUrl(parsed.config, 'chat'))).toBe('nav.items');
    expect(failingField(() => resolveAppPageUrl(parsed.config, 'missing'))).toBe('nav.items');
  });

  it('validates allowedOrigins entries', () => {
    for (const bad of ['https://a.example.com/', 'https://a.example.com/path', 'http://a.example.com', 'https://*.example.com', 'https://u:p@a.example.com', 'a.example.com']) {
      expect(failingField(() => parseAppFile(appFile({ allowedOrigins: [bad] })))).toBe('allowedOrigins[0]');
    }
    expect(parseAppFile(appFile({ allowedOrigins: ['https://a.example.com:8443', 'http://127.0.0.1:5173', 'http://localhost'] })).config.allowedOrigins).toHaveLength(3);
    expect(failingField(() => parseAppFile(appFile({ allowedOrigins: ['https://a.example.com', 'https://a.example.com'] })))).toBe('allowedOrigins[1]');
  });

  it('accepts exact https origins and loopback http only', () => {
    expect(isAllowedAppPageOrigin('https://gu.qq.com')).toBe(true);
    expect(isAllowedAppPageOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedAppPageOrigin('http://192.168.1.2')).toBe(false);
    expect(isAllowedAppPageOrigin('https://gu.qq.com?x')).toBe(false);
    expect(isAllowedAppPageOrigin(42)).toBe(false);
  });
});

describe('isAppName', () => {
  it('takes lower-case letters, digits and dashes only', () => {
    expect(isAppName('contract-review')).toBe(true);
    expect(isAppName('9to5')).toBe(true);
    expect(isAppName('-lead')).toBe(false);
    expect(isAppName('Contract')).toBe(false);
    expect(isAppName('x'.repeat(APP_LIMITS.nameLength + 1))).toBe(false);
  });
});
