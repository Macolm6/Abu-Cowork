import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { mkdir, copyFile, rename, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useI18n } from '@/i18n';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { ContextMenu } from '@/components/ds/context-menu';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub } from '@/components/ds/menu';
import { Pressable } from '@/components/ds/pressable';
import { TextField } from '@/components/ds/text-field';
import { usePreviewStore } from '@/stores/previewStore';
import { useToastStore } from '@/stores/toastStore';
import { useChatStore } from '@/stores/chatStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getFolderName, useWorkspaceStore } from '@/stores/workspaceStore';
import { getComposerDraftKey, getComposerDraftScopeForEnterpriseMode } from '@/stores/composerDraftStore';
import { useWorkspaceTree, type UseWorkspaceTreeResult, type WorkspaceTreeEntry } from '@/hooks/useWorkspaceTree';
import { joinPath, getBaseName, getParentDir, normalizeSeparators } from '@/utils/pathUtils';
import { cn } from '@/lib/utils';

// Extension → icon lookup. Deliberately simple (mirrors FilesSection's getFileIcon) —
// this is a lightweight glance at the project, not a full IDE file-type registry.
function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';

  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h'].includes(ext)) {
    return AppIcons.fileCode;
  }
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) {
    return AppIcons.fileJson;
  }
  if (['md', 'txt', 'log'].includes(ext)) {
    return AppIcons.file;
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
    return AppIcons.fileImage;
  }
  return AppIcons.fileGeneric;
}

const INDENT_PX = 14;
const BASE_PADDING_PX = 6;

function indentOf(depth: number): number {
  return depth * INDENT_PX + BASE_PADDING_PX;
}

/**
 * Resolve a destination path under `dir` for `fileName` that doesn't already
 * exist, appending " (1)", " (2)", … before the extension on collision. Guards
 * "Add file" against Tauri's copyFile silently overwriting an existing file.
 */
async function nonCollidingPath(dir: string, fileName: string): Promise<string> {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  let candidate = joinPath(dir, fileName);
  for (let n = 1; await exists(candidate); n++) {
    candidate = joinPath(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

/** What a row is, as plain values: the watcher hands out new entry objects on every re-read. */
type RowEntry = Pick<WorkspaceTreeEntry, 'name' | 'path' | 'isDirectory'>;

type CreateKind = 'file' | 'folder';

// What a menu was asked to do that takes the focus; carried out once the menu has closed.
type PendingAction = { kind: 'rename' | 'newFile' | 'newFolder' | 'delete'; entry: RowEntry };

// What the menu of the workspace folder's own row was asked to do that takes the focus or
// the keyboard; carried out once the menu has closed.
type RootMenuAction = { kind: 'newFolder' | 'addFile' } | { kind: 'recent'; path: string } | { kind: 'browse' };

interface WorkspaceFileTreeProps {
  /** Ask the system folder picker for a workspace folder. */
  onSelectWorkspace: () => void;
  /** Make `path` the workspace; the owner asks for access first when the folder has none. */
  onSwitchFolder: (path: string) => void;
  /** Whether switching to `path` opens the access dialog, which takes the focus. */
  folderNeedsAccess: (path: string) => boolean;
}

// One line of the tree as it shows: a file or folder, the name field for a new entry,
// or what an open folder has to say about its content.
type TreeItem =
  | { kind: 'row'; entry: WorkspaceTreeEntry; depth: number }
  | { kind: 'create'; folderPath: string; createKind: CreateKind; depth: number }
  | { kind: 'hint'; folderPath: string; hint: 'loading' | 'loadError' | 'empty'; depth: number };

type TreeListing = Pick<UseWorkspaceTreeResult, 'childrenByPath' | 'expandedPaths' | 'loadingPaths' | 'errorsByPath'>;

/** Lists `entries` and everything under their open folders, top to bottom. */
function appendVisibleItems(
  items: TreeItem[],
  entries: WorkspaceTreeEntry[],
  depth: number,
  listing: TreeListing,
  creatingInFolder: { folderPath: string; kind: CreateKind } | null,
) {
  for (const entry of entries) {
    items.push({ kind: 'row', entry, depth });
    if (!entry.isDirectory || !listing.expandedPaths.has(entry.path)) continue;
    const children = listing.childrenByPath.get(entry.path);
    const childDepth = depth + 1;
    if (creatingInFolder?.folderPath === entry.path) {
      items.push({ kind: 'create', folderPath: entry.path, createKind: creatingInFolder.kind, depth: childDepth });
    }
    if (listing.loadingPaths.has(entry.path) && !children) {
      items.push({ kind: 'hint', folderPath: entry.path, hint: 'loading', depth: childDepth });
    }
    if (listing.errorsByPath.get(entry.path)) {
      items.push({ kind: 'hint', folderPath: entry.path, hint: 'loadError', depth: childDepth });
    }
    if (children && children.length === 0) {
      items.push({ kind: 'hint', folderPath: entry.path, hint: 'empty', depth: childDepth });
    }
    if (children) appendVisibleItems(items, children, childDepth, listing, creatingInFolder);
  }
}

/**
 * Minimal reusable inline text input for the tree's "type a name" interactions
 * (rename, new file, new folder — both the per-row context menu and the
 * header's "..." menu). Caller supplies layout (icon/indentation) around it;
 * this only owns the value + commit/cancel keyboard behavior. autoFocus +
 * onBlur-submits + Enter/Escape mirrors the pre-existing header new-folder
 * input and Sidebar's inline conversation rename.
 */
function InlineNameInput({
  initialValue = '',
  placeholder,
  onSubmit,
  onCancel,
}: {
  initialValue?: string;
  placeholder?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  // Fire commit/cancel at most once: Enter commits then unmounts the input, and
  // a trailing blur (or a blur racing an Escape) must not re-run onSubmit against
  // the already-renamed/removed path.
  const settled = useRef(false);
  const submit = (v: string) => { if (settled.current) return; settled.current = true; onSubmit(v); };
  const cancel = () => { if (settled.current) return; settled.current = true; onCancel(); };
  return (
    <TextField
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => submit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(value); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      onClick={(e) => e.stopPropagation()}
      // A right-click in the field is about its text and never reaches the row menu.
      onContextMenu={(e) => e.stopPropagation()}
      placeholder={placeholder}
      className="min-w-0 flex-1"
    />
  );
}

interface TreeRowProps {
  path: string;
  name: string;
  isDirectory: boolean;
  depth: number;
  isExpanded: boolean;
  /** This file is the one open in the preview panel. */
  isActive: boolean;
  /** The open row menu, or the delete question, is about this row. */
  isMenuTarget: boolean;
  isRenaming: boolean;
  toggleExpand: (path: string) => void;
  openPreview: (path: string) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, entry: RowEntry) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>, entry: RowEntry) => void;
  onRenameSubmit: (entry: RowEntry, name: string) => void;
  onRenameCancel: () => void;
}

// A folder can hold thousands of files: the row is memoized and takes plain values and
// stable callbacks only, so a re-read of the folder, another file being previewed or a
// folder opening leaves the other rows alone.
const TreeRow = memo(function TreeRow({
  path,
  name,
  isDirectory,
  depth,
  isExpanded,
  isActive,
  isMenuTarget,
  isRenaming,
  toggleExpand,
  openPreview,
  onContextMenu,
  onPointerDown,
  onRenameSubmit,
  onRenameCancel,
}: TreeRowProps) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const focusRowAfterRename = useRef(false);

  // Escape in the rename field gives the focus back to the row it replaced.
  useEffect(() => {
    if (isRenaming || !focusRowAfterRename.current) return;
    focusRowAfterRename.current = false;
    rowRef.current?.focus();
  }, [isRenaming]);

  const entry: RowEntry = { name, path, isDirectory };
  const rowPadding = { paddingLeft: indentOf(depth), paddingRight: BASE_PADDING_PX };

  const handleActivate = () => {
    if (isDirectory) {
      toggleExpand(path);
    } else {
      openPreview(path);
    }
  };

  const leading = (
    <>
      {isDirectory ? (
        <Icon icon={isExpanded ? AppIcons.expand : AppIcons.disclose} size="sm" className="text-label-tertiary" />
      ) : (
        // A file keeps the arrow's place (a small icon is 14px) so names of one level line up.
        <span aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <Icon
        icon={isDirectory ? (isExpanded ? AppIcons.folderOpen : AppIcons.folder) : getFileIcon(name)}
        size="sm"
        className="text-label-tertiary"
      />
    </>
  );

  if (isRenaming) {
    return (
      <div className="flex items-center gap-1" style={rowPadding}>
        {leading}
        <InlineNameInput
          initialValue={name}
          onSubmit={(next) => onRenameSubmit(entry, next)}
          onCancel={() => {
            focusRowAfterRename.current = true;
            onRenameCancel();
          }}
        />
      </div>
    );
  }

  return (
    <Pressable
      ref={rowRef}
      title={path}
      onClick={handleActivate}
      onContextMenu={(event) => onContextMenu(event, entry)}
      onPointerDown={(event) => onPointerDown(event, entry)}
      style={rowPadding}
      // The scroll area clips a focus ring drawn outside the row. An open menu takes the
      // pointer away from the page, so the row it is about carries the hover fill itself.
      className={cn(
        'group flex w-full items-center gap-1 rounded-control py-1 text-left text-ui focus-visible:ring-inset',
        isActive ? 'bg-fill-selected' : isMenuTarget ? 'bg-fill-hover' : 'hover:bg-fill-hover',
      )}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate text-label">{name}</span>
    </Pressable>
  );
});

/**
 * Lightweight, lazily-expanding file tree of the workspace folder: the content of the
 * 「所有文件」 section of the task summary. The folder itself is the first row, and its menu
 * (right-click, or the 「更多操作」 button the row shows on hover) re-reads it, reveals it in
 * the file manager, adds entries to it and changes the workspace (the recent folders and the
 * system folder picker). Deliberately NOT a full IDE explorer: no drag/drop, no
 * multi-select — but each row does support a right-click context menu (reveal in Finder /
 * add to chat / copy path / rename / delete / new file & folder inside a directory),
 * mirroring TRAE Work. `onSelectWorkspace` serves the state with no workspace folder.
 */
function WorkspaceFileTree({ onSelectWorkspace, onSwitchFolder, folderNeedsAccess }: WorkspaceFileTreeProps) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const openPreview = usePreviewStore((s) => s.openPreview);
  const previewFilePath = usePreviewStore((s) => s.previewFilePath);
  const recentPaths = useWorkspaceStore((s) => s.recentPaths);
  const {
    rootPath,
    rootEntries,
    isRootLoading,
    rootError,
    rootMissing,
    childrenByPath,
    expandedPaths,
    loadingPaths,
    errorsByPath,
    toggleExpand,
    refresh,
  } = useWorkspaceTree();

  // The workspace folder's own row folds the whole tree away and opens it again.
  const [rootExpanded, setRootExpanded] = useState(true);
  // New folders and added files from the folder row's menu land in the workspace root; the
  // fs-watch auto-refresh + manual refresh keep the tree in sync.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingInFolder, setCreatingInFolder] = useState<{ folderPath: string; kind: CreateKind } | null>(null);
  // Rename, new file, new folder and the delete confirmation all take the focus, so a
  // menu item only records them here; the menu's close hook carries them out.
  const pendingActionRef = useRef<PendingAction | null>(null);
  // The folder row menu's choice, carried out by that menu's close hook.
  const pendingRootRef = useRef<RootMenuAction | null>(null);
  // One right-click menu serves every row: thousands of files stay one menu. It shows
  // the actions of the row its opening gesture began on.
  const [menuTarget, setMenuTarget] = useState<RowEntry | null>(null);
  const [rowMenuOpen, setRowMenuOpen] = useState(false);
  // The row a delete question is about, so the row stays marked while the question is open.
  const [askingPath, setAskingPath] = useState<string | null>(null);
  const menuRowRef = useRef<HTMLElement | null>(null);
  const rowRightClick = useRef<Event | null>(null);
  // The row under the gesture that can open the menu next. The menu opens from a right-click
  // event, and from a touch or a pen that stays down, which sends no event when its time is up.
  const gestureRow = useRef<{ entry: RowEntry; element: HTMLElement } | null>(null);
  // Read when an answer or a menu's close hook arrives, which can be renders later.
  const rootPathRef = useRef(rootPath);
  const expandedPathsRef = useRef(expandedPaths);
  const visiblePathsRef = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    rootPathRef.current = rootPath;
    expandedPathsRef.current = expandedPaths;
  });
  // The delete question outlives the tree (the dialog belongs to the app). Once the
  // tree has gone there is no workspace to check an answer against, so it is refused.
  useEffect(() => () => { rootPathRef.current = null; }, []);

  const submitNewFolder = async (rawName: string) => {
    setCreatingFolder(false);
    const name = rawName.trim();
    if (!name || !rootPath) return;
    const target = joinPath(rootPath, name);
    try {
      // mkdir(recursive:true) silently succeeds on an existing dir — check first
      // so a same-name folder gives feedback instead of a no-op.
      if (await exists(target)) {
        useToastStore.getState().addToast({
          type: 'error', title: t.panel.fileTree.newFolderFailed, message: t.panel.fileTree.alreadyExists,
        });
        return;
      }
      await mkdir(target, { recursive: true });
      refresh();
    } catch (err) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.newFolderFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleAddFile = async () => {
    if (!rootPath) return;
    try {
      const selected = await openFileDialog({ multiple: true });
      if (!selected) return;
      const files = Array.isArray(selected) ? selected : [selected];
      for (const src of files) {
        // Tauri's copyFile overwrites the destination silently. Never clobber an
        // existing same-named file — pick a non-colliding "name (n).ext" instead.
        const dest = await nonCollidingPath(rootPath, getBaseName(src));
        await copyFile(src, dest);
      }
      refresh();
    } catch (err) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.addFileFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleRevealInFinder = useCallback(async (entry: RowEntry) => {
    try {
      await revealItemInDir(entry.path);
    } catch (err) {
      console.error('[WorkspaceFileTree] revealItemInDir failed:', err);
    }
  }, []);

  const handleRevealRoot = async () => {
    if (!rootPath) return;
    await revealItemInDir(rootPath);
  };

  // A menu opened again, or another menu of the tree opened, before a close hook ran would
  // leave the earlier choice waiting. Drop the choices of both menus whenever one opens, or
  // the next Escape would carry them out.
  const handleRootMenuOpenChange = (open: boolean) => {
    if (!open) return;
    pendingRootRef.current = null;
    pendingActionRef.current = null;
  };

  // The name field, the system folder picker and the access dialog take the keyboard, so
  // they open only after the menu has gone, with the menu's focus return cancelled.
  // Switching to a folder that already has access opens nothing: the focus goes back to
  // where the menu was opened from.
  const handleRootMenuCloseAutoFocus = (event: Event) => {
    const action = pendingRootRef.current;
    pendingRootRef.current = null;
    if (!action) return;
    if (action.kind === 'recent' && !folderNeedsAccess(action.path)) {
      onSwitchFolder(action.path);
      return;
    }
    event.preventDefault();
    if (action.kind === 'newFolder') {
      setRootExpanded(true);
      setCreatingFolder(true);
    } else if (action.kind === 'addFile') {
      void handleAddFile();
    } else if (action.kind === 'recent') {
      onSwitchFolder(action.path);
    } else {
      onSelectWorkspace();
    }
  };

  // "Add to chat" — pushes an explicitly workspace-scoped path into
  // chatStore's ephemeral pendingAttachmentRequests buffer. ChatInput drains
  // only the records for the draft key active when the user clicked.
  const handleAddToChat = useCallback((entry: RowEntry) => {
    const chatState = useChatStore.getState();
    const draftScope = getComposerDraftScopeForEnterpriseMode(useEnterpriseStore.getState().mode);
    chatState.addPendingAttachment({
      path: entry.path,
      draftKey: getComposerDraftKey(chatState.activeConversationId, draftScope),
      readScope: 'workspace',
    });
    useToastStore.getState().addToast({ type: 'success', title: t.panel.fileTree.addedToChat });
  }, [t]);

  const handleCopyPath = useCallback(async (entry: RowEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path);
      useToastStore.getState().addToast({ type: 'success', title: t.panel.fileTree.copyPathDone });
    } catch (err) {
      console.error('[WorkspaceFileTree] clipboard write failed:', err);
    }
  }, [t]);

  const handleRenameSubmit = useCallback(async (entry: RowEntry, rawName: string) => {
    setRenamingPath(null);
    const name = rawName.trim();
    if (name === entry.name) return; // unchanged — silent no-op, matches Sidebar's rename behavior
    if (!name || name.includes('/')) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.renameFailed,
        message: t.panel.fileTree.invalidName,
      });
      return;
    }
    const newPath = joinPath(getParentDir(entry.path), name);
    try {
      await rename(entry.path, newPath);
      // Follow the rename across ALL open preview tabs: any tab showing the
      // renamed entry (or a file under a renamed folder) is re-pointed in
      // place. Otherwise a tab stays pinned to a now-missing path and shows a
      // broken/stale render.
      usePreviewStore.getState().retargetPreviewPath(entry.path, newPath);
      refresh();
    } catch (err) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.renameFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [t, refresh]);

  const handleRenameCancel = useCallback(() => setRenamingPath(null), []);

  const handleCreateSubmit = async (folderPath: string, kind: CreateKind, rawName: string) => {
    setCreatingInFolder(null);
    const name = rawName.trim();
    const failTitle = kind === 'folder' ? t.panel.fileTree.newFolderFailed : t.panel.fileTree.newFileFailed;
    if (!name || name.includes('/')) {
      useToastStore.getState().addToast({ type: 'error', title: failTitle, message: t.panel.fileTree.invalidName });
      return;
    }
    const targetPath = joinPath(folderPath, name);
    try {
      // Never clobber an existing entry: mkdir(recursive) is a silent no-op on an
      // existing dir, and writeTextFile('') would truncate an existing file —
      // both must surface "already exists" instead.
      if (await exists(targetPath)) {
        useToastStore.getState().addToast({ type: 'error', title: failTitle, message: t.panel.fileTree.alreadyExists });
        return;
      }
      if (kind === 'folder') {
        await mkdir(targetPath, { recursive: true });
      } else {
        await writeTextFile(targetPath, '');
        openPreview(targetPath);
      }
      refresh();
    } catch (err) {
      useToastStore.getState().addToast({
        type: 'error',
        title: failTitle,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDeleteConfirmed = useCallback(async (entry: RowEntry) => {
    // Defense in depth: the fs:allow-remove capability is broad ($HOME/**, to
    // match write/rename), so the ONLY thing keeping this recursive delete from
    // touching files outside the project is that the tree is rooted at the
    // workspace. Enforce that explicitly — refuse to remove the root itself or
    // anything not strictly under it, so a bad entry.path can never escape.
    // The workspace is the one the tree shows now: it can change while the question is open.
    const rootPath = rootPathRef.current;
    const root = rootPath ? normalizeSeparators(rootPath).replace(/\/+$/, '') : '';
    const target = normalizeSeparators(entry.path).replace(/\/+$/, '');
    if (!root || !target.startsWith(root + '/')) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.deleteFailed,
        message: t.panel.fileTree.invalidName,
      });
      return;
    }
    try {
      // Move to the OS trash (Finder / Recycle Bin) instead of permanently
      // deleting — recoverable, and it runs via our own Rust command so it
      // doesn't depend on the fs:remove capability scope. Directories go whole.
      await invoke('move_to_trash', { path: entry.path });
      // Close only the preview tab(s) showing the trashed file or files under a
      // trashed folder — iterates all preview tabs and leaves unrelated tabs
      // (other previews, browser, terminal) untouched.
      usePreviewStore.getState().closePreviewTabsForPath(entry.path);
      refresh();
    } catch (err) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.fileTree.deleteFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [t, refresh]);

  // Abu cannot undo this itself (the file comes back only from the system trash), so it
  // asks, and the question names the file or folder it is about.
  const confirmDelete = async (entry: RowEntry) => {
    setAskingPath(entry.path);
    const confirmed = await confirm({
      title: t.panel.fileTree.confirmDelete,
      message: entry.name,
      confirmLabel: t.panel.fileTree.moveToTrash,
      tone: 'danger',
    });
    setAskingPath((current) => (current === entry.path ? null : current));
    if (confirmed) await handleDeleteConfirmed(entry);
  };

  // As for the folder row's menu: whenever the row menu opens, the choices of both menus go.
  const handleRowMenuOpenChange = (open: boolean) => {
    if (open) {
      pendingActionRef.current = null;
      pendingRootRef.current = null;
      const row = gestureRow.current;
      if (!row) throw new Error('The row menu opens only for a gesture that began on a row');
      menuRowRef.current = row.element;
      setMenuTarget(row.entry);
    }
    setRowMenuOpen(open);
  };

  const handleRowContextMenu = useCallback((event: MouseEvent<HTMLElement>, entry: RowEntry) => {
    rowRightClick.current = event.nativeEvent;
    gestureRow.current = { entry, element: event.currentTarget };
  }, []);

  const handleRowPointerDown = useCallback((event: PointerEvent<HTMLElement>, entry: RowEntry) => {
    if (event.pointerType !== 'mouse') gestureRow.current = { entry, element: event.currentTarget };
  }, []);

  // The name field and the confirmation open only after the menu has gone, with the
  // menu's own focus return cancelled so they keep the focus they take.
  const handleRowMenuCloseAutoFocus = (event: Event) => {
    const action = pendingActionRef.current;
    if (!action) return;
    pendingActionRef.current = null;
    const { entry } = action;
    // The file went away (deleted, moved, its folder re-read) while its menu was open.
    if (!visiblePathsRef.current.has(entry.path)) return;
    event.preventDefault();
    if (action.kind === 'rename') {
      setRenamingPath(entry.path);
      return;
    }
    if (action.kind === 'delete') {
      // The confirmation gives the focus back to whatever had it: the row that asked.
      const row = menuRowRef.current;
      if (row?.isConnected) row.focus();
      void confirmDelete(entry);
      return;
    }
    if (!expandedPathsRef.current.has(entry.path)) toggleExpand(entry.path);
    setCreatingInFolder({ folderPath: entry.path, kind: action.kind === 'newFolder' ? 'folder' : 'file' });
  };

  // ── The workspace folder's own menu (its 「更多操作」 button and a right-click) ──
  const renderRootMenu = (path: string) => (
    <>
      <MenuItem icon={AppIcons.reload} onSelect={refresh}>
        {t.panel.fileTree.refresh}
      </MenuItem>
      <MenuItem icon={AppIcons.openIn} onSelect={() => { void handleRevealRoot(); }}>
        {t.panel.openInFinder}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={AppIcons.newFolder} onSelect={() => { pendingRootRef.current = { kind: 'newFolder' }; }}>
        {t.panel.fileTree.newFolder}
      </MenuItem>
      <MenuItem icon={AppIcons.fileCreate} onSelect={() => { pendingRootRef.current = { kind: 'addFile' }; }}>
        {t.panel.fileTree.addFile}
      </MenuItem>
      <MenuSeparator />
      <MenuSub icon={AppIcons.folderOpen} label={t.panel.fileTree.changeFolder}>
        <MenuLabel>
          <span className="block max-w-64 whitespace-normal break-all">{path}</span>
        </MenuLabel>
        <MenuSeparator />
        {recentPaths.length > 0 && (
          <>
            <MenuLabel>{t.panel.recentlyUsed}</MenuLabel>
            <MenuRadioGroup
              value={path}
              onValueChange={(next) => { pendingRootRef.current = { kind: 'recent', path: next }; }}
            >
              {recentPaths.map((recent) => (
                <MenuRadioItem key={recent} value={recent}>{getFolderName(recent)}</MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
          </>
        )}
        <MenuItem onSelect={() => { pendingRootRef.current = { kind: 'browse' }; }}>
          {t.panel.selectOtherFolder}
        </MenuItem>
      </MenuSub>
    </>
  );

  // ── Per-node context menu (right-click) ──────────────────────────────
  const renderRowMenu = (entry: RowEntry) => (
    <>
      <MenuItem icon={AppIcons.folderOpen} onSelect={() => { void handleRevealInFinder(entry); }}>
        {t.panel.fileTree.revealInFinder}
      </MenuItem>
      {!entry.isDirectory && (
        <MenuItem icon={AppIcons.attach} onSelect={() => handleAddToChat(entry)}>
          {t.panel.fileTree.addToChat}
        </MenuItem>
      )}
      <MenuItem icon={AppIcons.copy} onSelect={() => { void handleCopyPath(entry); }}>
        {t.panel.fileTree.copyPath}
      </MenuItem>
      <MenuItem icon={AppIcons.rename} onSelect={() => { pendingActionRef.current = { kind: 'rename', entry }; }}>
        {t.panel.fileTree.rename}
      </MenuItem>
      {entry.isDirectory && (
        <>
          <MenuItem icon={AppIcons.fileCreate} onSelect={() => { pendingActionRef.current = { kind: 'newFile', entry }; }}>
            {t.panel.fileTree.newFile}
          </MenuItem>
          <MenuItem icon={AppIcons.newFolder} onSelect={() => { pendingActionRef.current = { kind: 'newFolder', entry }; }}>
            {t.panel.fileTree.newFolder}
          </MenuItem>
        </>
      )}
      <MenuSeparator />
      <MenuItem tone="danger" icon={AppIcons.delete} onSelect={() => { pendingActionRef.current = { kind: 'delete', entry }; }}>
        {t.panel.fileTree.delete}
      </MenuItem>
    </>
  );

  const items = useMemo(() => {
    const list: TreeItem[] = [];
    // Depth 0 is the workspace folder's own row; its entries start one level in.
    appendVisibleItems(list, rootEntries, 1, { childrenByPath, expandedPaths, loadingPaths, errorsByPath }, creatingInFolder);
    return list;
  }, [rootEntries, childrenByPath, expandedPaths, loadingPaths, errorsByPath, creatingInFolder]);

  // The rows on screen, for the menu's close hook. A choice waiting for a row that has
  // left the tree is dropped, so a file that comes back does not start in rename mode.
  useLayoutEffect(() => {
    const paths = new Set<string>();
    for (const item of items) if (item.kind === 'row') paths.add(item.entry.path);
    visiblePathsRef.current = paths;
    const action = pendingActionRef.current;
    if (action && !paths.has(action.entry.path)) pendingActionRef.current = null;
  }, [items]);

  const hintText = { loading: t.panel.fileTree.loading, loadError: t.panel.fileTree.loadError, empty: t.panel.fileTree.empty };

  const renderItem = (item: TreeItem) => {
    if (item.kind === 'row') {
      const { entry } = item;
      return (
        <TreeRow
          key={entry.path}
          path={entry.path}
          name={entry.name}
          isDirectory={entry.isDirectory}
          depth={item.depth}
          isExpanded={entry.isDirectory && expandedPaths.has(entry.path)}
          // Highlight the file currently open in the preview panel (files only).
          isActive={!entry.isDirectory && previewFilePath === entry.path}
          isMenuTarget={(rowMenuOpen && menuTarget?.path === entry.path) || askingPath === entry.path}
          isRenaming={renamingPath === entry.path}
          toggleExpand={toggleExpand}
          openPreview={openPreview}
          onContextMenu={handleRowContextMenu}
          onPointerDown={handleRowPointerDown}
          onRenameSubmit={handleRenameSubmit}
          onRenameCancel={handleRenameCancel}
        />
      );
    }
    if (item.kind === 'create') {
      return (
        <div
          key={`create:${item.folderPath}`}
          className="flex items-center gap-1"
          style={{ paddingLeft: indentOf(item.depth), paddingRight: BASE_PADDING_PX }}
        >
          <Icon
            icon={item.createKind === 'folder' ? AppIcons.newFolder : AppIcons.fileCreate}
            size="sm"
            className="text-label-tertiary"
          />
          <InlineNameInput
            placeholder={
              item.createKind === 'folder'
                ? t.panel.fileTree.newFolderPlaceholder
                : t.panel.fileTree.newFilePlaceholder
            }
            onSubmit={(name) => handleCreateSubmit(item.folderPath, item.createKind, name)}
            onCancel={() => setCreatingInFolder(null)}
          />
        </div>
      );
    }
    return (
      <div
        key={`${item.hint}:${item.folderPath}`}
        style={{ paddingLeft: indentOf(item.depth) }}
        className="py-1 text-caption text-label-tertiary"
      >
        {hintText[item.hint]}
      </div>
    );
  };

  if (!rootPath) {
    return (
      <div className="flex flex-col items-start gap-2 py-1">
        <Button size="sm" onClick={onSelectWorkspace}>{t.panel.selectWorkspace}</Button>
      </div>
    );
  }

  // What the workspace folder has to say about itself, one level in, where its entries go.
  const rootHint = (text: string) => (
    <p style={{ paddingLeft: indentOf(1) }} className="py-1 text-caption text-label-tertiary">{text}</p>
  );

  return (
    <div>
      {/* The workspace folder's own row: it folds the tree, and its menu holds the folder's
          actions. The 「更多操作」 button shows on hover and on keyboard focus. */}
      <ContextMenu
        content={renderRootMenu(rootPath)}
        onOpenChange={handleRootMenuOpenChange}
        onCloseAutoFocus={handleRootMenuCloseAutoFocus}
      >
        <div className="group flex items-center rounded-control hover:bg-fill-hover">
          <Pressable
            onClick={() => setRootExpanded(!rootExpanded)}
            aria-expanded={rootExpanded}
            style={{ paddingLeft: indentOf(0) }}
            className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-ui focus-visible:ring-inset"
          >
            <Icon icon={rootExpanded ? AppIcons.expand : AppIcons.disclose} size="sm" className="text-label-tertiary" />
            <Icon icon={rootExpanded ? AppIcons.folderOpen : AppIcons.folder} size="sm" className="text-label-tertiary" />
            <span className="min-w-0 flex-1 truncate font-medium text-label">{getFolderName(rootPath)}</span>
          </Pressable>
          <Menu
            align="end"
            onOpenChange={handleRootMenuOpenChange}
            onCloseAutoFocus={handleRootMenuCloseAutoFocus}
            trigger={(
              <IconButton
                size="sm"
                icon={AppIcons.more}
                label={t.panel.fileTree.moreActions}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              />
            )}
          >
            {renderRootMenu(rootPath)}
          </Menu>
        </div>
      </ContextMenu>

      {rootExpanded && creatingFolder && (
        <div className="flex items-center gap-1" style={{ paddingLeft: indentOf(1), paddingRight: BASE_PADDING_PX }}>
          <Icon icon={AppIcons.newFolder} size="sm" className="text-label-tertiary" />
          <InlineNameInput
            placeholder={t.panel.fileTree.newFolderPlaceholder}
            onSubmit={submitNewFolder}
            onCancel={() => setCreatingFolder(false)}
          />
        </div>
      )}

      {!rootExpanded ? null : rootMissing ? (
        rootHint(t.panel.fileTree.folderDeleted)
      ) : rootError ? (
        <div style={{ paddingLeft: indentOf(1) }} className="flex flex-col items-start gap-2 py-1">
          <p className="text-caption text-label-tertiary">{t.panel.fileTree.loadError}</p>
          <Button size="sm" onClick={refresh}>{t.panel.fileTree.refresh}</Button>
        </div>
      ) : isRootLoading && rootEntries.length === 0 ? (
        rootHint(t.panel.fileTree.loading)
      ) : rootEntries.length === 0 ? (
        rootHint(t.panel.fileTree.empty)
      ) : (
        <ContextMenu
          content={menuTarget ? renderRowMenu(menuTarget) : null}
          // A long press between the rows, on a hint or in a name field has no row.
          canOpen={() => gestureRow.current !== null}
          onOpenChange={handleRowMenuOpenChange}
          onCloseAutoFocus={handleRowMenuCloseAutoFocus}
        >
          <div
            // A new touch or pen press starts with no row; the row it lands on reports itself next.
            onPointerDownCapture={(event) => { if (event.pointerType !== 'mouse') gestureRow.current = null; }}
            // The menu writes its open state on its trigger, and a changed attribute here
            // makes the browser restyle every row below (60 ms with 2000 files). Nothing
            // reads that attribute, so the list declines it.
            data-state={undefined}
            // Only a right-click that came through a row opens the menu.
            onContextMenu={(event) => { if (rowRightClick.current !== event.nativeEvent) event.preventDefault(); }}
          >
            {items.map(renderItem)}
          </div>
        </ContextMenu>
      )}
    </div>
  );
}

// A folder can hold thousands of rows; the tree takes one stable callback, so a render of
// the panel around it does not reach them.
export default memo(WorkspaceFileTree);
