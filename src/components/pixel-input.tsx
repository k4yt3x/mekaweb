import { useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button } from './ui/button';

/** A draft number field: Enter commits; the step buttons commit immediately. */
export function PixelInput({
  id,
  name,
  label,
  value,
  step,
  fullWidthFallback,
  onCommit,
}: {
  id?: string | undefined;
  name?: string;
  label: string;
  value: number | 'full';
  step: number;
  fullWidthFallback?: number;
  onCommit: (value: number | 'full') => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<{ source: typeof value; text?: string }>({ source: value });
  // A replaced external value retires the old draft, even if that value returns later.
  if (draft.source !== value) setDraft({ source: value });
  const text =
    draft.source === value && draft.text !== undefined
      ? draft.text
      : value === 'full'
        ? ''
        : String(value);
  const full = fullWidthFallback !== undefined && text === '';
  const numeric = Number(text);

  function commit(delta = 0) {
    const node = input.current;
    if (!node?.reportValidity()) return;
    let next: number | 'full' = node.value === '' ? 'full' : node.valueAsNumber;
    if (delta) {
      next =
        next === 'full' ? (fullWidthFallback ?? 1) : Math.max(1, Number((next + delta).toFixed(6)));
    }
    if (typeof next === 'number' && (!Number.isFinite(next) || next < 1)) return;
    onCommit(next);
    setDraft({ source: value });
  }

  return (
    <div className="pixel-input">
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Decrease ${label.toLowerCase()}`}
        disabled={!full && text !== '' && numeric <= 1}
        onClick={() => commit(-step)}
      >
        <Minus size={16} aria-hidden="true" />
      </Button>
      <div className="pixel-input-field">
        <input
          ref={input}
          id={id}
          name={name}
          type="number"
          inputMode="decimal"
          enterKeyHint="done"
          min={1}
          step="any"
          required={fullWidthFallback === undefined}
          aria-label={label}
          title={
            fullWidthFallback === undefined
              ? 'Size in pixels. Press Enter to apply.'
              : 'Width in pixels. Leave blank for full width. Press Enter to apply.'
          }
          placeholder={fullWidthFallback === undefined ? undefined : 'Full'}
          value={text}
          onChange={(event) => setDraft({ source: value, text: event.target.value })}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey)
              return;
            if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              if (event.key === 'ArrowUp' && full) return;
              commit(event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0);
            } else if (event.key === 'Escape') {
              setDraft({ source: value });
            }
          }}
        />
        {!full && <span aria-hidden="true">px</span>}
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Increase ${label.toLowerCase()}`}
        disabled={full}
        onClick={() => commit(step)}
      >
        <Plus size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}
