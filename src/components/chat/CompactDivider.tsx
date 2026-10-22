import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { IconButton } from '@/components/ds/button';
import { Pressable } from '@/components/ds/pressable';
import MarkdownRenderer from './MarkdownRenderer';
import type { Message } from '@/types';

const COPIED_MS = 2000;

/**
 * Inline divider rendered for a compact-boundary marker message. Old messages
 * stay above it unchanged; pressing the row shows the summary that replaced
 * them below it. The expanded state is owned by the caller because the list
 * unmounts rows that scroll far out of view.
 */
export default function CompactDivider({ message, expanded, onToggle }: {
  message: Message;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const source = message.compactBoundary?.source;
  const label =
    source === 'manual'
      ? t.chat.compactDivider.compactedManual
      : t.chat.compactDivider.compacted;
  const summary = message.compactBoundary?.summaryText ?? '';
  const hasSummary = summary.trim() !== '';
  const open = hasSummary && expanded;

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(summary);
    setCopied(true);
  };

  if (!hasSummary) {
    return (
      <div className="my-3 flex items-center gap-2 px-2 text-label-tertiary">
        <div className="h-px flex-1 bg-separator" />
        <Icon icon={AppIcons.compact} size="sm" />
        <span className="select-none text-ui-sm">{label}</span>
        <span className="select-none text-ui-sm">{t.chat.compactDivider.noSummary}</span>
        <div className="h-px flex-1 bg-separator" />
      </div>
    );
  }

  return (
    <div className="my-3">
      <Pressable
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-control px-2 text-label-tertiary"
      >
        <span className="h-px flex-1 bg-separator" />
        <Icon
          icon={AppIcons.disclose}
          size="sm"
          label={open ? t.chat.compactDivider.collapse : t.chat.compactDivider.expand}
          className={cn('transition-transform duration-fast', open && 'rotate-90')}
        />
        <Icon icon={AppIcons.compact} size="sm" />
        <span className="select-none text-ui-sm">{label}</span>
        <span className="h-px flex-1 bg-separator" />
      </Pressable>
      {open && (
        <div className="block-expand block-expand-open block-expand-enter">
          <div className="mt-2 flex items-start gap-2 pl-7">
            <div className="min-w-0 flex-1 break-words text-label select-text">
              <MarkdownRenderer content={summary} variant="assistant" />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {copied && <span className="text-caption text-label-tertiary">{t.chat.htmlWidgetCopied}</span>}
              <IconButton
                size="sm"
                icon={copied ? AppIcons.done : AppIcons.copy}
                label={copied ? t.chat.htmlWidgetCopied : t.chat.copy}
                onClick={handleCopy}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
