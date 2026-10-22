import { useMemo } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { usePluginStore } from '@/stores/pluginStore';
import type { Team } from '@/stores/teamStore';
import { useVisibleTeams } from '@/core/team/useVisibleTeams';
import { resolveRoleId } from '@/core/team/roleIdentity';
import { localizedTeam } from '@/core/team/localizedTeam';
import { useI18n } from '@/i18n';
import type { SubagentDefinition } from '@/types';

/** Who answers in a team-pinned conversation (design §2.3: the leader is the root agent). */
export interface ConversationTeamLeader {
  teamId: string;
  /** The team's name in the interface language. */
  teamName: string;
  /** The leader's name in the interface language. */
  leaderName: string;
  /** Render with <AgentAvatar agent={leader}/> — the one avatar rule. */
  leader: SubagentDefinition;
  teamAvatar: string | null;
}

export function teamLeaderFromTeam(team: Team | null | undefined): ConversationTeamLeader | null {
  if (!team) return null;
  const leader = resolveRoleId(team.leaderRoleId);
  if (!leader) return null;
  return {
    teamId: team.id,
    teamName: team.name,
    leaderName: leader.name,
    leader,
    teamAvatar: team.avatar?.trim() || null,
  };
}

/**
 * Reactive: follows the conversation's team pin and the team store. Returns
 * null for ordinary conversations, so callers fall back to Abu's own avatar.
 */
export function useConversationTeamLeader(conversationId: string | null | undefined): ConversationTeamLeader | null {
  const teamId = useChatStore((s) => (conversationId ? s.conversations[conversationId]?.teamId : undefined));
  const teams = useVisibleTeams();
  const { locale } = useI18n();
  const stored = teamId ? teams.find((entry) => entry.id === teamId) ?? null : null;
  const team = useMemo(() => (stored ? localizedTeam(stored, locale) : null), [stored, locale]);
  // The leader resolves through the agent registry, which fills in after launch.
  const agents = useDiscoveryStore((s) => s.agents);
  // …and a file-backed leader only resolves once plugin records are ready,
  // which at launch lands after discovery (see useConversationTeam).
  const pluginRecordsReady = usePluginStore((s) => s.activationReady);
  return useMemo(() => {
    const found = teamLeaderFromTeam(team);
    return found ? { ...found, leaderName: found.leader.displayNames?.[locale] ?? found.leader.name } : null;
  }, [team, locale, agents, pluginRecordsReady]); // eslint-disable-line react-hooks/exhaustive-deps
}
