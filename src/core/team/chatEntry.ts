import { getVisibleTeams } from '@/stores/teamStore';

/**
 * Composer entry for teams (in-conversation team, 2026-09-04).
 *
 * The composer normally turns `@<team>` into the team chip, which pins the
 * conversation (`Conversation.teamId`) so the team's leader runs the loop.
 * This helper is the fallback for a mention that reached ChatView as text
 * (sent before the exact-name detection, pasted, typed after attachments):
 * it names the team and returns the message without the mention so the
 * conversation can be pinned and the text sent normally.
 *
 * Matching: the first non-attachment line must start with '@' followed by the
 * longest active-team-name prefix (team names may contain spaces), ended by
 * end-of-line, whitespace or a comma. A team that carries per-locale names
 * (`i18n`) answers to each of them as well. `@<agent>` is deliberately NOT handled
 * here — mentioning a member keeps inline delegation.
 */
export interface TeamMentionMatch {
  teamId: string;
  teamName: string;
  /** The message with the mention removed (attachment markers kept). */
  rest: string;
}

const ATTACHMENT_MARKER = /^\[Attachment: `[^`]+`\]$/;

export function matchTeamMention(rawText: string): TeamMentionMatch | null {
  const lines = rawText.split('\n');
  // Skip what the composer prepends ahead of the user's text: attachment
  // markers, quoted-reference headers (`[引用 …]`) and blockquote lines.
  const idx = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !ATTACHMENT_MARKER.test(trimmed) && !trimmed.startsWith('[') && !trimmed.startsWith('>');
  });
  if (idx < 0) return null;
  const line = lines[idx].trimStart();
  if (!line.startsWith('@')) return null;
  const candidate = line.slice(1);

  const teams = getVisibleTeams().filter(team => !team.managed || team.managed.ready);
  const endsMention = (after: string) => after === '' || /^[\s,，]/.test(after);
  // `typed` is how many characters of the line the mention takes.
  const matches: Array<{ id: string; name: string; typed: number }> = [];
  const consider = (team: { id: string; name: string }, typed: number) => {
    matches.push({ id: team.id, name: team.name, typed });
  };
  for (const team of teams) {
    if (candidate.startsWith(team.name) && endsMention(candidate.slice(team.name.length))) consider(team, team.name.length);
    // A team is also reached by the name the interface shows for it in any
    // locale, as an expert is by its display names; case does not matter there.
    for (const text of Object.values(team.i18n ?? {})) {
      const alias = text?.name;
      if (!alias) continue;
      if (candidate.slice(0, alias.length).toLowerCase() === alias.toLowerCase() && endsMention(candidate.slice(alias.length))) consider(team, alias.length);
    }
  }
  if (matches.length === 0) return null;
  // The longest mention wins; among equals, the first one found.
  const best = matches.reduce((longest, match) => (match.typed > longest.typed ? match : longest));

  const remainder = candidate.slice(best.typed).replace(/^[\s,，]+/, '');
  const restLines = lines.slice();
  restLines[idx] = remainder;
  const rest = restLines.filter((l, i) => i !== idx || l.length > 0).join('\n').trim();
  return { teamId: best.id, teamName: best.name, rest };
}
