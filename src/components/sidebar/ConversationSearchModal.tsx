import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useNoticeBadgeStore } from '@/stores/noticeBadgeStore';
import { useI18n } from '@/i18n';
import { Dialog } from '@/components/ds/dialog';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { NavItem } from '@/components/ds/nav-item';
import { TextField } from '@/components/ds/text-field';
import { catalogSearch, type SearchHit, type ConversationMeta } from '@/core/session/conversationStorage';
import { renderMarkedText, highlightQuery } from '@/utils/searchHighlight';
import type { Project } from '@/types/project';

const HL = 'rounded-control bg-fill-selected font-semibold text-label';

// The catalog cuts its answer to a row count before this window leaves out the conversations
// that stay out of the search, so it is asked for more conversations than the window lists.
const CONTENT_FETCH_LIMIT = 500;
const CONTENT_LIST_LIMIT = 50;

// Strip the `[Attachment: `name`]` prefix from a title for display (mirrors the
// sidebar's row rendering), falling back to the raw title if stripping empties it.
const ATTACH_RE = /\[Attachment:\s*`[^`]*`\]\s*/g;
const cleanTitle = (title: string): string => title.replace(ATTACH_RE, '').trim() || title;

type Projects = Record<string, Project>;

// The conversations the user started, wherever the sidebar lists them: the recent tasks and
// the tasks of every listed project. The runs of scheduled tasks and triggers are produced in
// the background and stay out, as do the tasks of an archived project.
const isSearchable = (c: ConversationMeta, projects: Projects): boolean =>
  !c.scheduledTaskId && !c.triggerId && !(c.projectId && projects[c.projectId]?.archived);

const projectNameOf = (c: ConversationMeta, projects: Projects): string | undefined =>
  c.projectId ? projects[c.projectId]?.name : undefined;

// One result: the title, and under it the project the conversation belongs to and the
// passage that matched, each only when there is one.
function ResultRow({ id, title, project, passage, onPick }: {
  id: string;
  title: ReactNode;
  project?: ReactNode;
  passage?: ReactNode;
  onPick: () => void;
}) {
  const detailId = `search-detail-${id}`;
  const hasDetail = project !== undefined || passage !== undefined;
  return (
    <div>
      <NavItem
        icon={AppIcons.conversation}
        label={title}
        aria-describedby={hasDetail ? detailId : undefined}
        onClick={onPick}
      />
      {hasDetail && (
        <div
          id={detailId}
          onClick={onPick}
          className="flex cursor-pointer items-center gap-2 pl-8 pr-2 text-ui-sm text-label-tertiary"
        >
          {project !== undefined && (
            <span data-search-project className="flex max-w-1/2 shrink-0 items-center gap-1">
              <Icon icon={AppIcons.folder} size="sm" />
              <span className="truncate">{project}</span>
            </span>
          )}
          {passage !== undefined && <span className="min-w-0 truncate">{passage}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Command-palette-style conversation search. Opened from the title-bar search
 * icon. Empty query lists recent conversations; typing shows instant in-memory
 * matches on the title and the project name PLUS FTS5 body-content hits (via
 * `catalogSearch`), so an existing conversation is always findable by title even
 * if the catalog is cold/unindexed. A conversation of a project shows the
 * project's name under its title.
 * Enter opens the first result, the arrow keys move between the field and the
 * results, and picking a result jumps to that conversation and brings its
 * sidebar row into view.
 */
export default function ConversationSearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const projects = useProjectStore((s) => s.projects);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const clearCompletedStatus = useChatStore((s) => s.clearCompletedStatus);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const setFileTreeMode = usePreviewStore((s) => s.setFileTreeMode);
  const clearBadge = useNoticeBadgeStore((s) => s.clear);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Race guard: a stale in-flight request (from a previous keystroke) must not
  // overwrite the latest results once both resolve out of order.
  const tokenRef = useRef(0);

  const trimmed = query.trim();
  const isSearching = trimmed.length > 0;

  // Start empty each time the dialog opens; the dialog focuses the field itself.
  useEffect(() => {
    if (open) {
      setQuery('');
      setHits([]);
    }
  }, [open]);

  // Debounced full-text search. Empty query clears hits (recents are shown).
  useEffect(() => {
    if (!isSearching) {
      tokenRef.current++;
      setHits([]);
      return;
    }
    const token = ++tokenRef.current;
    const timer = setTimeout(() => {
      catalogSearch(trimmed, CONTENT_FETCH_LIMIT).then((res) => {
        if (tokenRef.current === token) setHits(res);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [trimmed, isSearching]);

  // Recent conversations shown when the query is empty.
  const recents = useMemo(
    () =>
      Object.values(conversationIndex)
        .filter((c) => isSearchable(c, projects))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50),
    [conversationIndex, projects]
  );

  // Instant in-memory matches on the title and on the project's name — reliable
  // regardless of catalog state.
  const titleMatches = useMemo(() => {
    if (!isSearching) return [];
    const q = trimmed.toLowerCase();
    return Object.values(conversationIndex)
      .filter((c) => isSearchable(c, projects))
      .filter((c) =>
        cleanTitle(c.title).toLowerCase().includes(q)
        || (projectNameOf(c, projects)?.toLowerCase().includes(q) ?? false))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [conversationIndex, projects, trimmed, isSearching]);

  // FTS body-content hits, scoped to the searchable conversations and deduped against the
  // instant matches (those render first, richer body hits after).
  const contentMatches = useMemo(() => {
    if (!isSearching) return [];
    const titleIds = new Set(titleMatches.map((c) => c.id));
    return hits.filter((h) => {
      const meta = conversationIndex[h.conv_id];
      return !!meta && isSearchable(meta, projects) && !titleIds.has(h.conv_id);
    });
  }, [hits, titleMatches, conversationIndex, projects, isSearching]);
  const bodyHits = contentMatches.slice(0, CONTENT_LIST_LIMIT);
  // More conversations match than are listed: the list ends with a line that says so.
  const hasMore = contentMatches.length > CONTENT_LIST_LIMIT || hits.length >= CONTENT_FETCH_LIMIT;

  const pick = (id: string, jumpQuery?: string) => {
    switchConversation(id);
    setViewMode('chat');
    setFileTreeMode(false);
    clearBadge(id);
    clearCompletedStatus(id);
    useProjectStore.getState().revealConversation(id, conversationIndex[id]?.projectId);
    // Body-content hits carry the query so ChatView can scroll to + highlight
    // the matching message. Title/recents picks pass nothing (no in-body target).
    if (jumpQuery) {
      useChatStore.getState().setPendingSearchJump({ convId: id, query: jumpQuery });
    }
    onClose();
  };

  // The project's name as a row shows it, with the query marked where the name matched it.
  const projectLabel = (c: ConversationMeta | undefined, marked?: string): ReactNode | undefined => {
    const name = c ? projectNameOf(c, projects) : undefined;
    if (name === undefined) return undefined;
    return marked ? highlightQuery(name, marked, HL) : name;
  };

  // ArrowDown / ArrowUp step through the field and the results in order.
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const results = listRef.current ? [...listRef.current.querySelectorAll<HTMLButtonElement>('button')] : [];
    const stops: HTMLElement[] = inputRef.current ? [inputRef.current, ...results] : results;
    const at = stops.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const next = event.key === 'ArrowDown' ? Math.min(at + 1, stops.length - 1) : Math.max(at - 1, 0);
    event.preventDefault();
    stops[next].focus();
  };

  const firstId = isSearching ? (titleMatches[0]?.id ?? bodyHits[0]?.conv_id) : recents[0]?.id;
  const isEmpty = isSearching ? titleMatches.length === 0 && bodyHits.length === 0 : recents.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t.common.search} titleHidden size="lg" placement="top">
      <div onKeyDown={moveFocus}>
        <div className="flex items-center gap-2">
          <Icon icon={AppIcons.search} className="text-label-tertiary" />
          <TextField
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && firstId) pick(firstId);
            }}
            placeholder={t.sidebar.searchPlaceholder}
            className="min-w-0 flex-1"
          />
        </div>

        {/* Results: as tall as their content, scrolling past the maximum */}
        <div ref={listRef} className="mt-3 max-h-80 space-y-1 overflow-y-auto">
          {isEmpty ? (
            <EmptyState icon={AppIcons.search} title={t.sidebar.noSearchResults} />
          ) : isSearching ? (
            <>
              {/* Instant matches on the title or the project's name */}
              {titleMatches.map((c) => (
                <ResultRow
                  key={c.id}
                  id={c.id}
                  title={highlightQuery(cleanTitle(c.title), trimmed, HL)}
                  project={projectLabel(c, trimmed)}
                  onPick={() => pick(c.id)}
                />
              ))}
              {/* FTS body-content hits: the title, and the matching passage under it */}
              {bodyHits.map((h) => (
                <ResultRow
                  key={h.conv_id}
                  id={h.conv_id}
                  title={highlightQuery(cleanTitle(h.title), trimmed, HL)}
                  project={projectLabel(conversationIndex[h.conv_id])}
                  passage={h.snippet ? renderMarkedText(h.snippet, HL) : undefined}
                  onPick={() => pick(h.conv_id, trimmed)}
                />
              ))}
              {hasMore && (
                <p role="status" className="px-2 py-1 text-ui-sm text-label-tertiary">
                  {t.sidebar.searchMoreResults}
                </p>
              )}
            </>
          ) : (
            recents.map((c) => (
              <ResultRow
                key={c.id}
                id={c.id}
                title={cleanTitle(c.title)}
                project={projectLabel(c)}
                onPick={() => pick(c.id)}
              />
            ))
          )}
        </div>
      </div>
    </Dialog>
  );
}
