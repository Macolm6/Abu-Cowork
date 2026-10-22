import { Tag } from '@/components/ds/tag';
import type { ConversationAppBinding } from '@/types/app';
import AppLogo from '@/components/app/AppLogo';
import { useI18n } from '@/i18n';
import { resolveLocalizedText } from '@/core/app/appBinding';

/** The app a conversation was started in, as a title-bar pill next to the team badge. */
export default function ConversationAppBadge({ binding }: { binding: ConversationAppBinding }) {
  const { locale } = useI18n();
  const name = resolveLocalizedText(binding.appName, locale);
  return (
    <span data-testid="chat-title-app-badge" className="ml-2 inline-flex min-w-0 shrink-0" title={name}>
      <Tag>
        <AppLogo name={name} logo={binding.appLogo} logoDark={binding.appLogoDark} icon={binding.appIcon} size="sm" className="h-4 w-4 rounded-control" />
        <span className="max-w-40 truncate">{name}</span>
      </Tag>
    </span>
  );
}
