import {
  useContext,
  useCallback,
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CaseSensitive } from 'lucide-react';
import { useRuntime, useSettings } from '../connections/context';
import {
  CONVERSATION_FONT,
  CONVERSATION_OFFSET,
  CONVERSATION_WIDTH,
  normalizeConversationOffset,
} from '../connections/storage';
import { Button } from './ui/button';
import { PixelInput } from './pixel-input';
import { useOverlayPadding } from './visual-viewport';
import { ReadingContext, type ReadingOptions, type ReadingState } from './reading-context';

type ReadingPosition = {
  scroller: HTMLElement;
  atStart: boolean;
  following: boolean;
  anchor: Element | null;
  fraction: number;
  screenY: number;
};

function readingPosition(pane: HTMLElement | null): ReadingPosition | undefined {
  const scroller = pane?.querySelector<HTMLElement>('.conversation-scroll');
  const column = pane?.querySelector<HTMLElement>('.conversation-history > .conversation-width');
  const dock = pane?.querySelector<HTMLElement>('.composer-dock');
  if (!scroller || !column || !dock) return;
  const bounds = column.getBoundingClientRect();
  const screenY = (scroller.getBoundingClientRect().top + dock.getBoundingClientRect().top) / 2;
  // The popover may cover this point in a short viewport; anchor the content beneath it.
  const anchor =
    document
      .elementsFromPoint((bounds.left + bounds.right) / 2, screenY)
      .find((hit) => column.contains(hit)) ?? null;
  const rect = anchor?.getBoundingClientRect();
  return {
    scroller,
    atStart: scroller.scrollTop === 0,
    following: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120,
    anchor,
    fraction: rect?.height ? (screenY - rect.top) / rect.height : 0,
    screenY,
  };
}

/** Key this pane by connection/session; the sidebar and saved preferences keep their own lifetimes. */
export function SessionContent({ children }: { children: ReactNode }) {
  const { storage } = useRuntime();
  const settings = useSettings();
  const saved = useMemo<ReadingOptions>(
    () => ({
      fontSize: settings.conversationFontSize,
      maxWidth: settings.conversationMaxWidth,
      anchor: settings.conversationAnchor,
      offset: settings.conversationOffset,
    }),
    [
      settings.conversationFontSize,
      settings.conversationMaxWidth,
      settings.conversationAnchor,
      settings.conversationOffset,
    ],
  );
  const [overrides, setOverrides] = useState<Partial<ReadingOptions>>({});
  const options = useMemo(() => ({ ...saved, ...overrides }), [saved, overrides]);
  const pane = useRef<HTMLElement>(null);
  const position = useRef<ReadingPosition | undefined>(undefined);
  // The center guide shows while the slider is held and briefly after the position changes.
  const [holding, setHolding] = useState(false);
  const [lingering, setLingering] = useState(false);
  const lingerTimer = useRef<number>(undefined);
  const flashGuide = useCallback(() => {
    setLingering(true);
    window.clearTimeout(lingerTimer.current);
    lingerTimer.current = window.setTimeout(() => setLingering(false), GUIDE_LINGER);
  }, []);
  useEffect(() => () => window.clearTimeout(lingerTimer.current), []);
  const holdGuide = useCallback(
    (hold: boolean) => {
      setHolding(hold);
      if (!hold) flashGuide();
    },
    [flashGuide],
  );
  const change = useCallback(
    (next: Partial<ReadingOptions> | null) => {
      if (next && ('offset' in next || 'anchor' in next)) flashGuide();
      // Only size changes rewrap the text; moving the column keeps every line where it was.
      if (!next || 'fontSize' in next || 'maxWidth' in next)
        position.current = readingPosition(pane.current);
      setOverrides((current) => {
        if (!next) return {};
        const updated: Partial<ReadingOptions> = { ...current, ...next };
        for (const key of Object.keys(updated) as (keyof ReadingOptions)[])
          if (updated[key] === saved[key]) delete updated[key];
        return updated;
      });
    },
    [saved, flashGuide],
  );
  useLayoutEffect(() => {
    const restore = position.current;
    position.current = undefined;
    if (!restore) return;
    const { scroller, atStart, following, anchor, fraction, screenY } = restore;
    if (following) scroller.scrollTop = scroller.scrollHeight;
    else if (atStart) scroller.scrollTop = 0;
    else if (anchor?.isConnected) {
      const rect = anchor.getBoundingClientRect();
      scroller.scrollTop += rect.top + rect.height * fraction - screenY;
    }
  }, [options]);
  const adjusted = Object.keys(overrides).length > 0;
  const saveDefaults = useCallback(
    (next: ReadingOptions) => {
      position.current = readingPosition(pane.current);
      storage.conversationAppearance(next);
      setOverrides({});
    },
    [storage],
  );
  const value = useMemo(
    () => ({ options, adjusted, change, saveDefaults, pane, holdGuide }),
    [options, adjusted, change, saveDefaults, holdGuide],
  );
  return (
    <ReadingContext.Provider value={value}>
      <section
        ref={pane}
        className="session-main"
        data-anchor={options.anchor}
        style={
          {
            '--reading-width': options.maxWidth === 'full' ? '100%' : `${options.maxWidth}px`,
            '--reading-offset': `${options.offset}px`,
            '--conversation-font-size': `${options.fontSize}px`,
          } as CSSProperties
        }
      >
        {children}
        <CenterGuide pane={pane} options={options} visible={holding || lingering} />
      </section>
    </ReadingContext.Provider>
  );
}

const GUIDE_LINGER = 1200;

/** The pane's reading column: the conversation's, or the composer's before one exists. */
function readingColumn(pane: HTMLElement | null) {
  return (
    pane?.querySelector<HTMLElement>('.conversation-history > .conversation-width') ??
    pane?.querySelector<HTMLElement>('.composer-area > .conversation-width')
  );
}

/**
 * A vertical line through the reading column's center, across the visible conversation. It is
 * placed from the column itself, after CSS has applied the anchor, offset, and limits.
 */
function CenterGuide({
  pane,
  options,
  visible,
}: {
  pane: RefObject<HTMLElement | null>;
  options: ReadingOptions;
  visible: boolean;
}) {
  const line = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = pane.current;
    if (!visible || !node) return;
    const place = () => {
      const column = readingColumn(node);
      const scroller = node.querySelector<HTMLElement>('.conversation-scroll');
      if (!column || !scroller || !line.current) return;
      const bounds = node.getBoundingClientRect();
      const box = column.getBoundingClientRect();
      const area = scroller.getBoundingClientRect();
      line.current.style.left = `${box.left + box.width / 2 - bounds.left}px`;
      line.current.style.top = `${area.top - bounds.top}px`;
      line.current.style.height = `${area.height}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    const column = readingColumn(node);
    if (column) observer.observe(column);
    return () => observer.disconnect();
  }, [pane, options, visible]);
  return (
    <div ref={line} className="center-guide" data-visible={visible || undefined} aria-hidden />
  );
}

type OffsetRange = { min: number; max: number };

/**
 * The offsets that put the reading column against either edge of the conversation area, measured
 * the way the stylesheet places it. They change with the window, panels, and column width.
 */
function offsetRange(pane: HTMLElement | null, anchor: ReadingOptions['anchor']) {
  const column = readingColumn(pane);
  const area = column?.parentElement;
  if (!column || !area) return;
  const style = getComputedStyle(area);
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const width = area.clientWidth - paddingLeft - (parseFloat(style.paddingRight) || 0);
  const left = area.getBoundingClientRect().left + area.clientLeft + paddingLeft;
  const page = pane?.closest('.app-shell')?.getBoundingClientRect();
  const center = anchor === 'area' || !page ? width / 2 : page.left + page.width / 2 - left;
  const half = column.getBoundingClientRect().width / 2;
  const min = Math.ceil(half - center);
  return { min, max: Math.max(min, Math.floor(width - half - center)) };
}

function useOffsetRange(
  pane: RefObject<HTMLElement | null>,
  anchor: ReadingOptions['anchor'],
  maxWidth: ReadingOptions['maxWidth'],
) {
  const [range, setRange] = useState<OffsetRange>();
  useEffect(() => {
    const node = pane.current;
    const measure = () =>
      setRange((current) => {
        const next = offsetRange(node, anchor);
        return current?.min === next?.min && current?.max === next?.max ? current : next;
      });
    measure();
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const column of node.querySelectorAll('.conversation-width')) observer.observe(column);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [pane, anchor, maxWidth]);
  return range;
}

/** Signed pixels with a true minus sign. */
function formatOffset(offset: number) {
  return `${offset < 0 ? '−' : ''}${Math.abs(offset)} px`;
}

function describeOffset(offset: number) {
  if (offset === 0) return 'Centered';
  return `${Math.abs(offset)} pixels ${offset < 0 ? 'left' : 'right'}`;
}

export function ReadingOptionsControl() {
  const value = useContext(ReadingContext);
  const collisionPadding = useOverlayPadding();
  if (!value) throw new Error('Reading options require SessionContent.');
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          className="reading-options-trigger"
          variant="ghost"
          size="icon"
          aria-label="Reading options"
          title="Reading options"
          data-adjusted={value.adjusted || undefined}
        >
          <CaseSensitive size={20} aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="reading-options"
          aria-label="Reading options"
          align="end"
          sideOffset={6}
          collisionPadding={collisionPadding}
        >
          <ReadingOptionsForm value={value} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ReadingOptionsForm({ value }: { value: ReadingState }) {
  const id = useId();
  const [edited, setEdited] = useState(false);
  const [generation, setGeneration] = useState(0);
  const { options, adjusted, change, saveDefaults, pane, holdGuide } = value;
  const range = useOffsetRange(pane, options.anchor, options.maxWidth);
  const movable = range !== undefined && range.max > range.min;
  const shown = range ? Math.max(range.min, Math.min(range.max, options.offset)) : options.offset;
  // Dragging near center settles on it, so returning to 0 needs no precision. Keys step exactly,
  // since a snap would pull a single step from 0 straight back.
  const snap = range ? Math.max(3, (range.max - range.min) * 0.02) : 0;
  const dragging = useRef(false);
  return (
    <form
      onChange={() => setEdited(true)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!event.currentTarget.reportValidity()) return;
        const data = new FormData(event.currentTarget);
        saveDefaults({
          fontSize: Number(data.get('fontSize')),
          maxWidth: data.get('maxWidth') === '' ? 'full' : Number(data.get('maxWidth')),
          anchor: options.anchor,
          offset: normalizeConversationOffset(Number(data.get('offset'))),
        });
        setEdited(false);
        setGeneration((current) => current + 1);
      }}
    >
      <div className="reading-options-section" role="group" aria-labelledby={id + '-size'}>
        <h3 id={id + '-size'}>Size</h3>
        <div className="reading-option-row">
          <label htmlFor={id + '-font'}>Font size</label>
          <PixelInput
            key={`font-${generation}`}
            id={id + '-font'}
            name="fontSize"
            label="Font size"
            value={options.fontSize}
            step={CONVERSATION_FONT.step}
            onCommit={(fontSize) => {
              if (typeof fontSize === 'number') change({ fontSize });
            }}
          />
        </div>
        <div className="reading-option-row">
          <label htmlFor={id + '-width'}>Max width</label>
          <PixelInput
            key={`width-${generation}`}
            id={id + '-width'}
            name="maxWidth"
            label="Max width"
            value={options.maxWidth}
            step={CONVERSATION_WIDTH.step}
            fullWidthFallback={CONVERSATION_WIDTH.default}
            onCommit={(maxWidth) => change({ maxWidth })}
          />
        </div>
      </div>
      <div className="reading-options-section" role="group" aria-labelledby={id + '-position'}>
        <h3 id={id + '-position'}>Position</h3>
        <div className="reading-option-row" role="radiogroup" aria-labelledby={id + '-anchor'}>
          <span id={id + '-anchor'}>Center on</span>
          <div className="segmented">
            {(
              [
                ['page', 'Page', 'Center on the middle of the page; panels do not move it'],
                ['area', 'Area', 'Center between the panels'],
              ] as const
            ).map(([anchor, label, title]) => (
              <label key={anchor} title={title}>
                <input
                  type="radio"
                  name="anchor"
                  value={anchor}
                  checked={options.anchor === anchor}
                  onChange={() => change({ anchor })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="reading-option-row">
          <label htmlFor={id + '-offset'}>Offset</label>
          <PixelInput
            key={`offset-${generation}`}
            id={id + '-offset'}
            name="offset"
            label="Offset"
            value={options.offset}
            step={CONVERSATION_OFFSET.step}
            min={-CONVERSATION_OFFSET.limit}
            hint="Pixels to move the conversation; negative moves it left. Press Enter to apply."
            onCommit={(offset) => {
              if (typeof offset === 'number')
                change({ offset: normalizeConversationOffset(offset) });
            }}
          />
        </div>
        <div className="reading-offset">
          <div
            className="reading-offset-track"
            style={
              movable && range.min <= 0 && range.max >= 0
                ? ({ '--zero': -range.min / (range.max - range.min) } as CSSProperties)
                : undefined
            }
          >
            <input
              type="range"
              aria-label="Offset slider"
              aria-valuetext={describeOffset(shown)}
              title="Drag to the notch to remove the offset"
              min={range?.min ?? 0}
              max={range?.max ?? 0}
              step={1}
              value={shown}
              disabled={!movable}
              onPointerDown={() => {
                dragging.current = true;
                holdGuide(true);
                // The release can land outside the slider.
                const end = () => {
                  dragging.current = false;
                  holdGuide(false);
                  window.removeEventListener('pointerup', end);
                  window.removeEventListener('pointercancel', end);
                };
                window.addEventListener('pointerup', end);
                window.addEventListener('pointercancel', end);
              }}
              onChange={(event) => {
                const next = Number(event.target.value);
                change({ offset: dragging.current && Math.abs(next) <= snap ? 0 : next });
              }}
            />
          </div>
          {!movable ? (
            <p>No room to move the conversation at this width.</p>
          ) : (
            options.offset !== 0 &&
            shown !== options.offset && <p>Limited to {formatOffset(shown)} at this width.</p>
          )}
        </div>
      </div>
      <div className="reading-options-footer">
        <Button
          variant="ghost"
          disabled={!adjusted && !edited}
          onClick={() => {
            change(null);
            setEdited(false);
            setGeneration((current) => current + 1);
          }}
          title="Restore saved appearance settings"
        >
          Reset
        </Button>
        <Button
          type="submit"
          variant="secondary"
          disabled={!adjusted && !edited}
          title="Save these reading options in Settings → Appearance"
        >
          Save
        </Button>
      </div>
    </form>
  );
}
