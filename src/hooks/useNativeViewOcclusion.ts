import { useSettingsStore } from '@/stores/settingsStore';
import { usePreviewStore } from '@/stores/previewStore';

/**
 * Is a React overlay up that the app page's native `WebContentsView` would paint over?
 *
 * The signals are the ones `BrowserTab` hides its view for: the system
 * settings dialog, a workspace popover, and whatever the layer registry
 * reports as painted (`dsModalOpen`: every dialog, question, approval, viewer
 * and layered fullscreen surface, until its fade has ended). The app page also
 * hides for every menu, select list and popover (`dsFloatingOpen`): it fills the
 * main area, and a menu opened from the sidebar or the title bar spreads over
 * it. CSS stacking is invisible to the native layer.
 */
export function useNativeViewOcclusion(): boolean {
  const systemSettingsOpen = useSettingsStore((s) => s.systemSettingsOpen);
  const menuOpen = usePreviewStore((s) => s.menuOpen);
  const dsModalOpen = usePreviewStore((s) => s.dsModalOpen);
  const dsFloatingOpen = usePreviewStore((s) => s.dsFloatingOpen);
  return systemSettingsOpen || menuOpen || dsModalOpen || dsFloatingOpen;
}
