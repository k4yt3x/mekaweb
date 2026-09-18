import type { KeyboardEvent } from 'react';

// Custom rich-content scroll regions need consistent keyboard behavior across browser engines.
export function scrollRegion(event: KeyboardEvent<HTMLElement>, region = event.currentTarget) {
  if (event.target !== region || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return;
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
  if (horizontal && region.scrollWidth > region.clientWidth) {
    event.preventDefault();
    region.scrollLeft += event.key === 'ArrowLeft' ? -60 : 60;
  } else if (vertical && region.scrollHeight > region.clientHeight) {
    event.preventDefault();
    region.scrollTop += event.key === 'ArrowUp' ? -60 : 60;
  }
}
