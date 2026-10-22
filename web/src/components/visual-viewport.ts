import { useEffect, useMemo, useSyncExternalStore } from 'react';

function subscribePadding(listener: () => void) {
  const viewport = window.visualViewport;
  window.addEventListener('resize', listener);
  viewport?.addEventListener('resize', listener);
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  return () => {
    window.removeEventListener('resize', listener);
    viewport?.removeEventListener('resize', listener);
    observer.disconnect();
  };
}
function paddingSnapshot() {
  const style = getComputedStyle(document.documentElement);
  const pixels = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
  return [
    10 + pixels('--safe-top') + pixels('--connection-banner-height'),
    10 + pixels('--safe-right'),
    10 + pixels('--safe-bottom'),
    10 + pixels('--safe-left'),
  ].join(',');
}

/** Match portaled menus to the safe bounds used by the app frame and dialogs. */
export function useOverlayPadding() {
  const snapshot = useSyncExternalStore(subscribePadding, paddingSnapshot, () => '10,10,10,10');
  return useMemo(() => {
    const [top = 10, right = 10, bottom = 10, left = 10] = snapshot.split(',').map(Number);
    return { top, right, bottom, left };
  }, [snapshot]);
}

/** Fit the app to the area above a mobile keyboard without changing pinch zoom. */
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const style = document.documentElement.style;
    let frame = 0;
    const measure = () => {
      if (viewport.scale === 1 && viewport.height > 0)
        style.setProperty('--viewport-height', `${viewport.height}px`);
    };
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    viewport.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', resize);
      style.removeProperty('--viewport-height');
    };
  }, []);
}
