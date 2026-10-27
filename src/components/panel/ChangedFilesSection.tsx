import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Button, IconButton } from '@/components/ds/button';
import { ContextMenu } from '@/components/ds/context-menu';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuLabel, MenuSub } from '@/components/ds/menu';
import { Pressable } from '@/components/ds/pressable';
import { Tag } from '@/components/ds/tag';
import { resolveFileSource, type ResolvedSource } from '@/core/session/outputSnapshots';
import type { ConversationChangedFile } from '@/core/session/conversationChangedFiles';
import { cachedTurnChangesEntry, useConversationChangedFiles } from '@/hooks/useTurnChanges';
import { format, useI18n } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import type { VersionMeta } from '@/utils/canvasVersions';
import { getBaseName } from '@/utils/pathUtils';
import { hasVersionHistory } from './previewToolbarConfig';
import SummarySection from './SummarySection';
import { VersionList, VersionRestoreDialog } from './VersionList';
import { formatVersionTime } from './versionTime';

/** Rows shown before the rest is asked for. */
const MAX_VISIBLE = 7;

function fileIcon(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h'].includes(ext)) return AppIcons.fileCode;
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) return AppIcons.fileJson;
  if (['md', 'txt', 'log'].includes(ext)) return AppIcons.file;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return AppIcons.fileImage;
  return AppIcons.fileGeneric;
}

function statusLabel(t: TranslationDict, status: ConversationChangedFile['status']): string {
  if (status === 'created') return t.panel.operationCreate;
  if (status === 'deleted') return t.panel.operationDelete;
  return t.panel.operationModify;
}

type Turn = ConversationChangedFile['turns'][number];

/** Opens the changes tab of `turn` on this file, titled as the card under that turn's reply titles it. */
function openTurn(t: TranslationDict, conversationId: string, turn: Turn): void {
  const entry = cachedTurnChangesEntry(conversationId, turn.loopId);
  if (!entry) return;
  const title = entry.total > 1
    ? format(t.panel.changesTabMany, { name: entry.firstFile, count: entry.total })
    : format(t.panel.changesTabSingle, { name: entry.firstFile });
  usePreviewStore.getState().openTurnChanges({ conversationId, loopId: turn.loopId, fileIndex: turn.fileIndex, title });
}

/**
 * What a row offers, shown by its 「更多操作」 button and by a right-click on
 * it: the changes of the turns that changed the file, its versions in this
 * conversation, and the file manager. Each item shows only where it applies.
 */
function RowMenuItems({ file, conversationId, resolved, onPickVersion }: {
  file: ConversationChangedFile;
  conversationId: string;
  resolved: ResolvedSource | null;
  onPickVersion: (version: VersionMeta) => void;
}) {
  const { t } = useI18n();
  const inPlace = resolved?.status === 'available' && !resolved.isFromSnapshot;
  // The running turn has no saved changes yet; its row offers them once the turn is saved.
  const savedTurns = file.turns.filter((turn) => cachedTurnChangesEntry(conversationId, turn.loopId) !== null);
  return (
    <>
      {savedTurns.length === 1 && (
        <MenuItem icon={AppIcons.fileEdit} onSelect={() => openTurn(t, conversationId, savedTurns[0])}>{t.panel.viewChanges}</MenuItem>
      )}
      {savedTurns.length > 1 && (
        <MenuSub icon={AppIcons.fileEdit} label={t.panel.viewChanges}>
          {savedTurns.map((turn) => (
            <MenuItem key={turn.loopId} description={formatVersionTime(turn.at)} onSelect={() => openTurn(t, conversationId, turn)}>
              {turn.prompt || formatVersionTime(turn.at)}
            </MenuItem>
          ))}
        </MenuSub>
      )}
      {inPlace && hasVersionHistory(file.path) && (
        <MenuSub icon={AppIcons.history} label={t.panel.versionHistory}>
          <MenuLabel>{t.panel.versionHistory}</MenuLabel>
          <VersionList filePath={file.path} conversationId={conversationId} onPick={onPickVersion} />
        </MenuSub>
      )}
      {inPlace && (
        <MenuItem icon={AppIcons.folderOpen} onSelect={() => { void revealItemInDir(file.path); }}>{t.panel.showInFinderButton}</MenuItem>
      )}
    </>
  );
}

const ChangedFileRow = memo(function ChangedFileRow({ file, conversationId }: { file: ConversationChangedFile; conversationId: string }) {
  const { t } = useI18n();
  const openPreview = usePreviewStore((s) => s.openPreview);
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);
  const picked = useRef<VersionMeta | null>(null);
  const [asking, setAsking] = useState<VersionMeta | null>(null);

  // Where the file can be read now: in place, as the copy Abu kept, or nowhere.
  useEffect(() => {
    let cancelled = false;
    resolveFileSource(conversationId, file.path)
      .then((r) => { if (!cancelled) setResolved(r); })
      .catch(() => {
        if (!cancelled) setResolved({ status: 'missing', basename: getBaseName(file.path), originalPath: file.path });
      });
    return () => { cancelled = true; };
  }, [file.path, file.status, conversationId]);

  const unavailable = resolved?.status === 'missing' || resolved?.status === 'skipped';

  const handleClick = () => {
    if (resolved?.status !== 'available') return;
    if (resolved.isFromSnapshot) openPreview(resolved.path, { keptCopyOf: file.path });
    else openPreview(resolved.path);
  };

  const handleMenuOpenChange = (open: boolean) => { if (open) picked.current = null; };
  // The question opens once the menu has given the focus back, and returns it there.
  const handleMenuCloseAutoFocus = () => {
    const version = picked.current;
    picked.current = null;
    if (version) setAsking(version);
  };

  const items = (
    <RowMenuItems
      file={file}
      conversationId={conversationId}
      resolved={resolved}
      onPickVersion={(version) => { picked.current = version; }}
    />
  );

  return (
    <>
      <ContextMenu content={items} onOpenChange={handleMenuOpenChange} onCloseAutoFocus={handleMenuCloseAutoFocus}>
        <div data-testid="changed-file-row" className={cn('group flex items-center rounded-control hover:bg-fill-hover', unavailable && 'opacity-60')}>
          <Pressable
            title={unavailable ? t.chat.fileMissing : file.path}
            onClick={handleClick}
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
          >
            <Icon icon={fileIcon(file.path)} size="sm" className="text-label-tertiary" />
            <span className={cn('min-w-0 flex-1 truncate text-ui', unavailable ? 'text-label-tertiary' : 'text-label')}>{getBaseName(file.path)}</span>
            <Tag>{statusLabel(t, file.status)}</Tag>
          </Pressable>
          <Menu
            align="end"
            onOpenChange={handleMenuOpenChange}
            onCloseAutoFocus={handleMenuCloseAutoFocus}
            trigger={(
              <IconButton
                size="sm"
                icon={AppIcons.more}
                label={t.panel.moreActions}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              />
            )}
          >
            {items}
          </Menu>
        </div>
      </ContextMenu>
      <VersionRestoreDialog filePath={file.path} version={asking} origin={{ conversationId }} onClose={() => setAsking(null)} />
    </>
  );
});

function SectionFrame({ count, children }: { count: number | null; children: ReactNode }) {
  const { t } = useI18n();
  const meta = count !== null && <span className="text-caption text-label-tertiary">{format(t.panel.filesCount, { count })}</span>;
  return (
    <SummarySection icon={AppIcons.fileEdit} title={t.panel.changedFiles} meta={meta}>
      {children}
    </SummarySection>
  );
}

function EmptyHint() {
  const { t } = useI18n();
  // Placed as the progress section's own empty line is.
  return <p className="py-4 text-center text-ui-sm text-label-tertiary">{t.panel.changedFilesEmpty}</p>;
}

function ChangedFilesList({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const { status, files } = useConversationChangedFiles(conversationId);
  const [expanded, setExpanded] = useState(false);
  if (status === 'loading') return <SectionFrame count={null}>{null}</SectionFrame>;
  if (files.length === 0) return <SectionFrame count={null}><EmptyHint /></SectionFrame>;
  const hidden = files.length - MAX_VISIBLE;
  const shown = expanded ? files : files.slice(0, MAX_VISIBLE);
  return (
    <SectionFrame count={files.length}>
      <div className="space-y-1">
        {shown.map((file) => <ChangedFileRow key={file.path} file={file} conversationId={conversationId} />)}
        {hidden > 0 && (
          <div className="flex justify-center">
            <Button variant="plain" size="sm" onClick={() => setExpanded(!expanded)}>
              {expanded ? t.panel.collapse : format(t.panel.changedFilesMore, { count: hidden })}
            </Button>
          </div>
        )}
      </div>
    </SectionFrame>
  );
}

/**
 * 「改过的文件」 in the task summary: every file the conversation created,
 * changed or deleted, once each, the latest changed first.
 */
export default function ChangedFilesSection() {
  const conversationId = useChatStore((s) => s.activeConversationId);
  return conversationId
    ? <ChangedFilesList key={conversationId} conversationId={conversationId} />
    : <SectionFrame count={null}><EmptyHint /></SectionFrame>;
}
