import { describe, expect, it } from 'vitest';
import type { Team } from '@/stores/teamStore';
import { BUILTIN_TEAMS } from './builtinTeams';
import { localizedTeam } from './localizedTeam';

const recruiting = BUILTIN_TEAMS.find((team) => team.id === 'builtin-team:recruiting')!;

describe('localizedTeam', () => {
  it('shows a built-in team in English under en-US', () => {
    const shown = localizedTeam(recruiting, 'en-US');
    expect(shown.name).toBe('Recruiting Team');
    expect(shown.description).toBe('From role to offer: the recruiter sets the bar, the researcher checks the market, the document expert prepares the materials');
    expect(shown.intro).toMatch(/^Tell me who you are hiring\./);
    expect(shown.expertise).toEqual(['Role profiles and JD writing', 'Salary market and candidate background research', 'Interview questions and scorecards']);
    expect(shown.samplePrompts).toHaveLength(4);
    expect(shown.samplePrompts?.[0]).toBe('Write a senior front-end JD with interview questions');
  });

  it('shows the stored Chinese text under zh-CN', () => {
    const shown = localizedTeam(recruiting, 'zh-CN');
    expect(shown).toBe(recruiting);
    expect(shown.name).toBe('招聘专家团');
    expect(shown.description).toBe('从岗位到 offer：招聘官定标准，调研专家摸行情，文档专家出材料');
  });

  it('keeps everything that is not display text', () => {
    const shown = localizedTeam(recruiting, 'en-US');
    expect(shown.id).toBe(recruiting.id);
    expect(shown.leaderRoleId).toBe(recruiting.leaderRoleId);
    expect(shown.memberRoleIds).toEqual(recruiting.memberRoleIds);
    expect(shown.avatar).toBe(recruiting.avatar);
    expect(shown.leaderNote).toBe(recruiting.leaderNote);
  });

  it('leaves the stored team as it was', () => {
    localizedTeam(recruiting, 'en-US');
    expect(recruiting.name).toBe('招聘专家团');
    expect(recruiting.samplePrompts?.[0]).toBe('帮我写一份高级前端的 JD 并定好面试题');
  });

  it("returns a user's team unchanged in every locale", () => {
    const mine: Team = {
      id: 'team-mine', name: '周报小队', leaderRoleId: 'role-a', memberRoleIds: ['role-a'], createdAt: 1,
      description: '每周收集并汇总周报', intro: '把这周的材料给我', expertise: ['汇总'], samplePrompts: ['汇总本周周报'],
    };
    expect(localizedTeam(mine, 'en-US')).toBe(mine);
    expect(localizedTeam(mine, 'zh-CN')).toBe(mine);
  });

  it('falls back field by field when a locale gives only some of the text', () => {
    const partial: Team = {
      id: 'team-partial', name: '数据小队', leaderRoleId: 'role-a', memberRoleIds: ['role-a'], createdAt: 1,
      description: '看数据', expertise: ['清洗'],
      i18n: { 'en-US': { name: 'Data Squad' } },
    };
    const shown = localizedTeam(partial, 'en-US');
    expect(shown.name).toBe('Data Squad');
    expect(shown.description).toBe('看数据');
    expect(shown.expertise).toEqual(['清洗']);
    expect(shown.intro).toBeUndefined();
  });
});
