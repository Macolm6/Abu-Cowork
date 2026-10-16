import { beforeEach, describe, expect, it } from 'vitest';
import { getI18n, initLanguage } from '@/i18n';
import type { AppDefinition } from '@/types/app';
import { resolveRun, type RefCatalog } from '@/core/app/appRefs';
import { describeSceneRun } from './runLabel';

const catalog: RefCatalog = {
  plugins: [], teams: [], getAgent: () => undefined, findManagedAgent: () => undefined,
  skillNames: new Set(), enterpriseSkillNames: new Set(),
};
const format = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
const app: AppDefinition = {
  appId: 'weekly@mine', name: '周报', version: '1.0.0', plugins: [],
  origin: { kind: 'created', authoringId: 'draft' },
  config: { version: 1, defaultRun: { team: 'mine:team-unique-id' } },
};

beforeEach(() => initLanguage('zh-CN'));

describe('scene owner names', () => {
  it('disables a scene when its team exists but its required skill is disabled', () => {
    const blocked = { ...app, plugins: ['tools'], config: { ...app.config, defaultRun: { team: 'mine:team-unique-id', skill: 'plugin:tools/check' } } };
    const refs: RefCatalog = { ...catalog,
      teams: [{ id: 'team-unique-id', name: '周报小组', leaderRoleId: 'l', memberRoleIds: ['l'], createdAt: 0 }],
      plugins: [{ key: 'tools@market', name: 'tools', marketplace: 'market', enabled: false, contributed: { agents: [], teams: [], skills: ['check'], mcpServers: [] } }],
    };
    const description = describeSceneRun(blocked, undefined, resolveRun(blocked, blocked.config.defaultRun, refs), getI18n(), format, 'zh-CN');
    expect(description).toEqual({ label: '技能「check」暂时不可用', unavailable: true });
  });

  it('keeps the remembered team name when its resource was removed', () => {
    const saved = { ...app, referenceNames: { 'team:mine:team-unique-id': '周报小组' } };
    const description = describeSceneRun(saved, undefined, resolveRun(saved, saved.config.defaultRun!, catalog), getI18n(), format, 'zh-CN');
    expect(description.unavailable).toBe(true);
    expect(description.label).toContain('周报小组');
    expect(description.label).not.toContain('team-unique-id');
  });

  it('uses a readable unavailable message for older apps without a remembered name', () => {
    const description = describeSceneRun(app, undefined, resolveRun(app, app.config.defaultRun!, catalog), getI18n(), format, 'zh-CN');
    expect(description).toEqual({ label: getI18n().appHome.sceneOwnerUnavailable, unavailable: true });
  });
});
