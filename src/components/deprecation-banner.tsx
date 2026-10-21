import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TriangleAlert, X } from 'lucide-react';
import { Button } from './ui/button';

/**
 * Announces the end of the hosted site, above every page including the welcome page. Closing it
 * lasts until the page reloads.
 */
export function DeprecationBanner() {
  const [open, setOpen] = useState(true);
  const element = useRef<HTMLElement>(null);
  // Fixed like the connection banner; its height moves the app down through `--app-top`.
  useLayoutEffect(() => {
    const banner = element.current;
    if (!open || !banner) return;
    const style = document.documentElement.style;
    const measure = () =>
      style.setProperty('--deprecation-banner-height', `${banner.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(banner);
    return () => {
      observer.disconnect();
      style.removeProperty('--deprecation-banner-height');
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <aside ref={element} className="deprecation-banner" aria-label="Deprecation notice">
      <TriangleAlert size={16} aria-hidden="true" />
      <p>
        web.meka.run is deprecated and will be removed soon. For more information and other
        versions, see{' '}
        <a href="https://github.com/k4yt3x/mekaweb" target="_blank" rel="noreferrer noopener">
          mekaweb on GitHub
        </a>
        .
      </p>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Dismiss deprecation notice"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setOpen(false)}
      >
        <X size={16} aria-hidden="true" />
      </Button>
    </aside>,
    document.body,
  );
}
