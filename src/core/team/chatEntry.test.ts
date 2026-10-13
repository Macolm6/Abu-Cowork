import { describe, it, expect, beforeEach } from 'vitest';
import { useTeamStore } from '@/stores/teamStore';
import { matchTeamMention } from './chatEntry';
import { BUILTIN_TEAMS } from './builtinTeams';

describe('matchTeamMention (composer fallback for a typed @团队)', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: []});
  });

  function seedTeam(name = '数据小队') {
    return useTeamStore.getState().createTeam({ name, leaderRoleId: 'role-l', memberRoleIds: [] });
  }

  it('names the team and returns the message without the mention', () => {
    const team = seedTeam();
    const res = matchTeamMention('@数据小队 出一版 8 月周报，异常波动单独列一节');
    expect(res).toEqual({ teamId: team.id, teamName: '数据小队', rest: '出一版 8 月周报，异常波动单独列一节' });
  });

  it('does not match non-team mentions — @agent keeps inline delegation', () => {
    seedTeam();
    expect(matchTeamMention('@writer 帮我看看这段')).toBeNull();
    expect(matchTeamMention('@数据小队长 出周报')).toBeNull(); // prefix of a longer word is not the team
  });

  it('matches the longest team name and supports Chinese comma separators', () => {
    seedTeam('数据');
    const long = seedTeam('数据小队');
    const res = matchTeamMention('@数据小队，出周报');
    expect(res?.teamId).toBe(long.id);
    expect(res?.rest).toBe('出周报');
  });

  it('returns an empty rest for a bare mention so the caller can hand the text back', () => {
    seedTeam();
    expect(matchTeamMention('@数据小队')).toMatchObject({ teamName: '数据小队', rest: '' });
  });

  it('ignores a team that has been deleted', () => {
    const team = seedTeam();
    useTeamStore.getState().deleteTeam(team.id);
    expect(matchTeamMention('@数据小队 干活')).toBeNull();
  });

  it('keeps attachment markers that precede the mention in the message', () => {
    seedTeam();
    const res = matchTeamMention('[Attachment: `/tmp/a.csv`]\n@数据小队 看看这份数据');
    expect(res?.teamName).toBe('数据小队');
    expect(res?.rest).toBe('[Attachment: `/tmp/a.csv`]\n看看这份数据');
  });

  it('skips quoted-reference lines the composer prepends and still finds the mention', () => {
    seedTeam();
    expect(matchTeamMention('[引用 1 · 来源：周报.md]\n> 上周 GMV\n\n@数据小队 干活')?.rest).toBe('[引用 1 · 来源：周报.md]\n> 上周 GMV\n\n干活');
  });

  it('does not treat a mention buried behind ordinary text as a team hand-off', () => {
    seedTeam();
    expect(matchTeamMention('先看这个\n@数据小队 干活')).toBeNull();
  });

  describe('built-in teams and their English names', () => {
    beforeEach(() => {
      useTeamStore.setState({ teams: [...BUILTIN_TEAMS] });
    });

    it('finds a built-in team by its English name and reports the stored one', () => {
      expect(matchTeamMention('@Recruiting Team write a senior front-end JD')).toEqual({
        teamId: 'builtin-team:recruiting', teamName: '招聘专家团', rest: 'write a senior front-end JD',
      });
      expect(matchTeamMention('@Finance Reconciliation Team, reconcile this quarter')).toMatchObject({
        teamId: 'builtin-team:finance-reconciliation', rest: 'reconcile this quarter',
      });
    });

    it('takes the English name in any letter case, and a bare mention', () => {
      expect(matchTeamMention('@recruiting team rank these resumes')).toMatchObject({ teamId: 'builtin-team:recruiting', rest: 'rank these resumes' });
      expect(matchTeamMention('@Recruiting Team')).toMatchObject({ teamId: 'builtin-team:recruiting', rest: '' });
    });

    it('still finds a built-in team by its stored Chinese name', () => {
      expect(matchTeamMention('@招聘专家团 写一份高级前端的 JD')).toEqual({
        teamId: 'builtin-team:recruiting', teamName: '招聘专家团', rest: '写一份高级前端的 JD',
      });
    });

    it('matches nothing for a name no team has, or a longer word that starts with one', () => {
      expect(matchTeamMention('@Marketing Team plan the launch')).toBeNull();
      expect(matchTeamMention('@Recruiting Teams plan the launch')).toBeNull();
      expect(matchTeamMention('@Recruiting plan the launch')).toBeNull();
    });

    it("leaves a user's team to its own name: it has no other", () => {
      const mine = useTeamStore.getState().createTeam({ name: '数据小队', leaderRoleId: 'role-l', memberRoleIds: [] });
      expect(matchTeamMention('@数据小队 出周报')).toMatchObject({ teamId: mine.id, rest: '出周报' });
      expect(matchTeamMention('@Data Squad weekly report')).toBeNull();
    });

    it('prefers the longer mention when a user team is named like the start of an English name', () => {
      useTeamStore.getState().createTeam({ name: 'Recruiting', leaderRoleId: 'role-l', memberRoleIds: [] });
      expect(matchTeamMention('@Recruiting Team rank these resumes')).toMatchObject({ teamId: 'builtin-team:recruiting', rest: 'rank these resumes' });
    });
  });
});
