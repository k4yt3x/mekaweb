import {
  createContext,
  useContext,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CaseSensitive } from 'lucide-react';
import { useRuntime, useSettings } from '../connections/context';
import { CONVERSATION_FONT, CONVERSATION_WIDTH, type Settings } from '../connections/storage';
import { Button } from './ui/button';
import { PixelInput } from './pixel-input';
import { useOverlayPadding } from './visual-viewport';

type ReadingOptions = {
  fontSize: number;
  maxWidth: Settings['conversationMaxWidth'];
};
type ReadingState = {
  options: ReadingOptions;
  adjusted: boolean;
  change: (options: Partial<ReadingOptions> | null) => void;
  saveDefaults: (options: ReadingOptions) => void;
};
const ReadingContext = createContext<ReadingState | null>(null);

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
  const { conversationFontSize, conversationMaxWidth } = useSettings();
  const [overrides, setOverrides] = useState<Partial<ReadingOptions>>({});
  const fontSize = overrides.fontSize ?? conversationFontSize;
  const maxWidth = overrides.maxWidth ?? conversationMaxWidth;
  const pane = useRef<HTMLElement>(null);
  const position = useRef<ReadingPosition | undefined>(undefined);
  const change = useCallback(
    (next: Partial<ReadingOptions> | null) => {
      position.current = readingPosition(pane.current);
      setOverrides((current) => {
        if (!next) return {};
        const updated = { ...current, ...next };
        if (updated.fontSize === conversationFontSize) delete updated.fontSize;
        if (updated.maxWidth === conversationMaxWidth) delete updated.maxWidth;
        return updated;
      });
    },
    [conversationFontSize, conversationMaxWidth],
  );
  useLayoutEffect(() => {
    const saved = position.current;
    position.current = undefined;
    if (!saved) return;
    const { scroller, atStart, following, anchor, fraction, screenY } = saved;
    if (following) scroller.scrollTop = scroller.scrollHeight;
    else if (atStart) scroller.scrollTop = 0;
    else if (anchor?.isConnected) {
      const rect = anchor.getBoundingClientRect();
      scroller.scrollTop += rect.top + rect.height * fraction - screenY;
    }
  }, [fontSize, maxWidth, overrides]);
  const adjusted = Object.keys(overrides).length > 0;
  const saveDefaults = useCallback(
    (next: ReadingOptions) => {
      position.current = readingPosition(pane.current);
      storage.conversationAppearance(next.fontSize, next.maxWidth);
      setOverrides({});
    },
    [storage],
  );
  const value = useMemo(
    () => ({ options: { fontSize, maxWidth }, adjusted, change, saveDefaults }),
    [fontSize, maxWidth, adjusted, change, saveDefaults],
  );
  return (
    <ReadingContext.Provider value={value}>
      <section
        ref={pane}
        className="session-main"
        style={
          {
            '--reading-width': maxWidth === 'full' ? '100%' : `${maxWidth}px`,
            '--conversation-font-size': `${fontSize}px`,
          } as CSSProperties
        }
      >
        {children}
      </section>
    </ReadingContext.Provider>
  );
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
  const { options, adjusted, change, saveDefaults } = value;
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
        });
        setEdited(false);
        setGeneration((current) => current + 1);
      }}
    >
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
          title="Save font size and max width in Settings → Appearance"
        >
          Save
        </Button>
      </div>
    </form>
  );
}
