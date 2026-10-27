import { useState, type ReactNode } from 'react';
import { Icon } from '@/components/ds/icon';
import { AppIcons, type AppIconName } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { cn } from '@/lib/utils';

/**
 * One section of the task summary: a title row that folds the section away and opens it
 * again, and the section's content under it. Every section of the summary has this shape,
 * so they read and behave alike. `meta` follows the title (a count, the live spinner).
 */
export default function SummarySection({ icon, title, meta, children }: {
  icon: (typeof AppIcons)[AppIconName];
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section aria-label={title} className="py-5 first:pt-0 last:pb-0">
      <h3>
        <Pressable
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon icon={icon} className="shrink-0 text-label-secondary" />
            <span className="truncate text-ui font-medium text-label">{title}</span>
            {meta}
          </span>
          <Icon
            icon={AppIcons.expand}
            size="sm"
            className={cn('shrink-0 text-label-tertiary transition-transform duration-fast', !expanded && '-rotate-90')}
          />
        </Pressable>
      </h3>
      <div hidden={!expanded} className="mt-3">{children}</div>
    </section>
  );
}
