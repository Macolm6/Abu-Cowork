import type { LucideIcon } from 'lucide-react';
import { Avatar as AvatarPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

const SIZE = { sm: 'h-5 w-5 text-caption', md: 'h-7 w-7 text-ui-sm', lg: 'h-9 w-9 text-ui' } as const;

// A user's picture, or on the neutral fill the first character of the name, or
// `placeholderIcon` when the owner shows a glyph for "no picture chosen".
export function Avatar({ name, src, size = 'md', placeholderIcon }: {
  name: string;
  src?: string;
  size?: keyof typeof SIZE;
  placeholderIcon?: LucideIcon;
}) {
  return (
    <AvatarPrimitive.Root className={cn('inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-medium', SIZE[size])}>
      {src && <AvatarPrimitive.Image src={src} alt={name} className="h-full w-full object-cover" />}
      {/* The fill is the no-photo background only; a transparent photo shows nothing behind it. */}
      <AvatarPrimitive.Fallback role="img" aria-label={name} className="flex h-full w-full items-center justify-center bg-fill text-label-secondary">
        {placeholderIcon
          ? <Icon icon={placeholderIcon} className="size-1/2" />
          : Array.from(name)[0]?.toUpperCase() ?? ''}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
