import { describe, expect, it } from 'vitest';
import { BUILTIN_TEAMS, BUILTIN_TEAM_ID_PREFIX, isBuiltinTeam } from './builtinTeams';
import { BUILTIN_AGENT_NAMES } from '../../../electron/shared/pluginAgentFormat.mjs';
import { BUILTIN_TEAM_IDS } from '../../../electron/shared/pluginSpec.mjs';

/**
 * The shipped 专家团 shelf. Ids and member names are release-frozen
 * identifiers: a rename breaks every conversation and schedule pinned to the
 * team, and a member name that no shipped expert answers to resolves to
 * nothing at run time (the roster silently shrinks). Both are pinned here.
 */
describe('builtinTeams', () => {
  it('every id carries the prefix and is unique', () => {
    const ids = BUILTIN_TEAMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const team of BUILTIN_TEAMS) expect(isBuiltinTeam(team)).toBe(true);
    expect(isBuiltinTeam({ id: 'team-abc' })).toBe(false);
    expect(BUILTIN_TEAM_ID_PREFIX).toBe('builtin-team:');
  });

  it('leader is a member and every member is a shipped built-in expert', () => {
    const shipped = new Set(BUILTIN_AGENT_NAMES as readonly string[]);
    for (const team of BUILTIN_TEAMS) {
      expect(team.memberRoleIds).toContain(team.leaderRoleId);
      for (const roleId of team.memberRoleIds) {
        expect(roleId.startsWith('builtin:')).toBe(true);
        expect(shipped.has(roleId.slice('builtin:'.length))).toBe(true);
      }
    }
  });

  it('matches the id list the package validator resolves `builtin-team:` references against', () => {
    expect(BUILTIN_TEAMS.map((t) => t.id)).toEqual([...BUILTIN_TEAM_IDS]);
  });

  it('names are unique, so a user team can never collide with two of them', () => {
    const names = BUILTIN_TEAMS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('ships six teams with copy filled in', () => {
    expect(BUILTIN_TEAMS).toHaveLength(6);
    for (const team of BUILTIN_TEAMS) {
      expect(team.description).toBeTruthy();
      expect(team.intro).toBeTruthy();
      expect(team.samplePrompts?.length).toBeGreaterThanOrEqual(3);
      expect(team.leaderNote).toBeTruthy();
    }
  });

  it('gives every team its English display text, field for field', () => {
    const cjk = /[㐀-鿿]/;
    for (const team of BUILTIN_TEAMS) {
      const english = team.i18n?.['en-US'];
      expect(english?.name).toBeTruthy();
      expect(english?.description).toBeTruthy();
      expect(english?.intro).toBeTruthy();
      expect(english?.expertise).toHaveLength(team.expertise!.length);
      expect(english?.samplePrompts).toHaveLength(team.samplePrompts!.length);
      const texts = [english!.name!, english!.description!, english!.intro!, ...english!.expertise!, ...english!.samplePrompts!];
      for (const text of texts) expect(text).not.toMatch(cjk);
    }
    const names = BUILTIN_TEAMS.map((team) => team.i18n!['en-US']!.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the stored fields in Chinese: they are what matching and prompts read', () => {
    expect(BUILTIN_TEAMS.map((team) => team.name)).toEqual([
      '软件研发专家团', '数据分析专家团', '内容创作专家团', '汇报材料专家团', '财务对账专家团', '招聘专家团',
    ]);
    for (const team of BUILTIN_TEAMS) expect(Object.keys(team.i18n ?? {})).toEqual(['en-US']);
  });
});
