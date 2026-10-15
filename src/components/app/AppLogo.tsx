import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { loadLocalImage } from '@/utils/pathUtils';
import { useEffectiveThemeIsDark } from '@/hooks/useEffectiveThemeIsDark';
import abuAvatar from '@/assets/abu-avatar.png';
import { Icon, type IconSize } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { AVATAR_ICON_MAP, parseAvatarValue } from '@/core/team/avatarPresets';

const SIZE = { sm: 'h-5 w-5 text-caption', md: 'h-7 w-7 text-ui-sm', lg: 'h-10 w-10 text-title', xl: 'h-14 w-14 text-title-lg' } as const;
const ICON_SIZE: Record<keyof typeof SIZE, IconSize> = { sm: 'sm', md: 'md', lg: 'md', xl: 'lg' };

/**
 * An app's logo: the package image (light or dark variant by theme) loaded
 * through the scoped file bridge, the icon an organization set for its app,
 * a neutral application mark while an image loads or when there is none, and
 * Abu's own avatar for the general shell.
 */
export default function AppLogo({ logo, logoDark, icon, general = false, size = 'md', className }: {
  name: string;
  logo?: string;
  logoDark?: string;
  /** An emoji or an `icon:<icon>/<tint>` preset. */
  icon?: string;
  /** The general shell: Abu's avatar instead of a package image. */
  general?: boolean;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const dark = useEffectiveThemeIsDark();
  const path = (dark ? logoDark : undefined) ?? logo ?? logoDark;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!path) { setSrc(null); return; }
    let url: string | null = null;
    let cancelled = false;
    void loadLocalImage(path).then((loaded) => {
      if (cancelled) { URL.revokeObjectURL(loaded); return; }
      url = loaded;
      setSrc(loaded);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  const box = cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-control bg-fill font-medium text-label-tertiary select-none', SIZE[size], className);
  if (general) return <span className={box} data-testid="app-logo" data-app-logo="general"><img src={abuAvatar} alt="" className="h-full w-full object-cover" /></span>;
  if (src) return <span className={box} data-testid="app-logo" data-app-logo="image"><img src={src} alt="" className="h-full w-full object-cover" /></span>;
  const parsed = parseAvatarValue(icon);
  return (
    <span className={box} data-testid="app-logo" data-app-logo={parsed.kind} aria-hidden="true">
      {parsed.kind === 'emoji' ? parsed.emoji : <Icon icon={parsed.kind === 'icon' ? AVATAR_ICON_MAP[parsed.icon] : AppIcons.appMarket} size={ICON_SIZE[size]} />}
    </span>
  );
}
