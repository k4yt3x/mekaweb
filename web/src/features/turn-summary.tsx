import { Fragment, useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { Schema } from '../api/client';
import { useOverlayPadding } from '../components/visual-viewport';
import { turnDetails, turnSummary } from '../session/turn-summary';

/** How long a pointer rests on the summary before its details show, and leaves before they go. */
const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 150;

/**
 * The row that closes an ended turn: how and when it ended, and after how long. Its details, what
 * the turn spent among them, show while a pointer rests on it, and stay after a click or a tap.
 */
export function TurnSummary({ turn }: { turn: Schema['TurnRecord'] }) {
  const collisionPadding = useOverlayPadding();
  const [open, setOpen] = useState<'hover' | 'pinned'>();
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const text = turnSummary(turn);
  if (!text) return null;
  /** Shows the details after a moment of resting on them, unless a click already pinned them. */
  function rest() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen((now) => now ?? 'hover'), OPEN_DELAY_MS);
  }
  /** Hides details a resting pointer showed, a moment after it leaves. */
  function leave() {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setOpen((now) => (now === 'hover' ? undefined : now)),
      CLOSE_DELAY_MS,
    );
  }
  return (
    <Popover.Root
      open={Boolean(open)}
      onOpenChange={(next) => {
        if (!next) setOpen(undefined);
      }}
    >
      <Popover.Anchor asChild>
        <button
          ref={trigger}
          type="button"
          className="turn-summary"
          aria-expanded={Boolean(open)}
          aria-haspopup="dialog"
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') rest();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') leave();
          }}
          onClick={() => {
            clearTimeout(timer.current);
            setOpen((now) => (now === 'pinned' ? undefined : 'pinned'));
          }}
        >
          {text}
        </button>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="turn-details"
          aria-label="Turn details"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={collisionPadding}
          // Shown by a resting pointer, it leaves the keyboard where it was.
          onOpenAutoFocus={(event) => {
            if (open === 'hover') event.preventDefault();
          }}
          // The summary itself toggles them, so a press on it is not a press outside.
          onInteractOutside={(event) => {
            if (event.target instanceof Node && trigger.current?.contains(event.target))
              event.preventDefault();
          }}
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') leave();
          }}
        >
          <dl>
            {turnDetails(turn).map(({ label, value }) => (
              <Fragment key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
          </dl>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
