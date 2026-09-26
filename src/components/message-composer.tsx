import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ImagePlus,
  Settings as SettingsIcon,
  SendHorizontal,
  Square,
  ListPlus,
  Zap,
  CornerDownRight,
  X,
} from 'lucide-react';
import type { ComposerOptions } from '../session/controller';
import { DEFAULT_INPUT_HEIGHT } from '../session/composer-options';
import { useSessionNavigation } from '../features/session-navigation';
import { useAction } from './actions';
import { ComposerResizeHandle } from './composer-resize-handle';
import { PermissionSelect } from './ui/permission-select';
import { ProfileSelect } from './ui/profile-select';
import { Button } from './ui/button';
import { shortcutAttribute, shortcutHint } from './shortcut-keys';

const actions = {
  send: { Icon: SendHorizontal, label: 'Send message' },
  queue: { Icon: ListPlus, label: 'Queue message' },
  steer: { Icon: CornerDownRight, label: 'Steer message' },
  interrupt: { Icon: Zap, label: 'Interrupt and send' },
  stop: { Icon: Square, label: 'Stop current turn' },
};

export function MessageComposer({
  text,
  onTextChange,
  readOnly,
  pending = false,
  placeholder,
  focusId,
  inputHeight,
  onResize,
  resizeGeneration,
  permission,
  profile,
  attachments,
  action,
  settings,
  onError,
  children,
}: {
  text: string;
  onTextChange: (value: string) => void;
  readOnly: boolean;
  /** Blocks edits while keeping focus, so a failed submission can be corrected in place. */
  pending?: boolean;
  placeholder: string;
  focusId: string;
  inputHeight: number;
  onResize: (height: number) => void;
  resizeGeneration: number;
  permission: ComponentProps<typeof PermissionSelect>;
  profile: ComponentProps<typeof ProfileSelect>;
  attachments: {
    value: ComposerOptions['images'];
    disabled: boolean;
    onChange: (update: (images: ComposerOptions['images']) => ComposerOptions['images']) => void;
  };
  action: { kind: keyof typeof actions; disabled: boolean; busy: boolean; run: () => void };
  settings: { disabled: boolean; busy: boolean; open: () => void };
  onError: (error: unknown) => void;
  children?: ReactNode;
}) {
  const inputId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileAction = useAction(onError);
  const { composerFocusRef } = useSessionNavigation();
  useLayoutEffect(() => {
    if (
      composerFocusRef.current !== focusId ||
      !input.current ||
      input.current.disabled ||
      !input.current.getClientRects().length
    )
      return;
    composerFocusRef.current = null;
    input.current.focus({ preventScroll: true });
  });
  const [maxHeight, setMaxHeight] = useState(DEFAULT_INPUT_HEIGHT);
  useEffect(() => {
    const inputBox = editor.current,
      container = area.current,
      composer = box.current;
    const scroller = container?.closest('.conversation-scroll');
    if (!inputBox || !container || !composer || !scroller) return;
    const observer = new ResizeObserver(() => {
      const overhead = container.scrollHeight - inputBox.offsetHeight;
      const maximum = Math.max(
        DEFAULT_INPUT_HEIGHT,
        Math.floor(scroller.clientHeight * 0.75 - overhead),
      );
      setMaxHeight(maximum);
      if (inputBox.offsetHeight > maximum) onResize(maximum);
    });
    observer.observe(scroller);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [onResize]);
  const stop = action.kind === 'stop';
  const { Icon, label } = actions[action.kind];
  const blocked = action.disabled || (!stop && fileAction.busy);
  // Shift+Tab belongs to the permission mode only while it can change; a pending save holds it
  // in place, and otherwise the key moves focus as usual.
  const cyclesPermission =
    !readOnly &&
    permission.options.length > 0 &&
    (!permission.disabled || Boolean(permission.busy));
  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (
      event.key === 'Tab' &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      cyclesPermission
    ) {
      event.preventDefault();
      if (event.repeat || permission.disabled) return;
      const next =
        permission.options[
          (permission.options.indexOf(permission.value ?? '') + 1) % permission.options.length
        ];
      if (next && next !== permission.value) permission.onChange(next);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat && !blocked && !stop) action.run();
    }
  }
  return (
    <div className="composer-area" ref={area}>
      <div className="conversation-width">
        {settings.busy && (
          <span className="sr-only" role="status">
            Saving session settings…
          </span>
        )}
        {!readOnly && permission.value && (
          <span className="sr-only" role="status">
            Permission mode: {permission.value}
          </span>
        )}
        {!readOnly && profile.value && (
          <span className="sr-only" role="status">
            Profile: {profile.value}
          </span>
        )}
        <div className="composer" ref={box}>
          <ComposerResizeHandle
            key={resizeGeneration}
            inputId={inputId}
            height={inputHeight}
            min={DEFAULT_INPUT_HEIGHT}
            max={maxHeight}
            onResize={onResize}
          />
          <div className="composer-editor" ref={editor} style={{ height: inputHeight }}>
            <textarea
              ref={input}
              id={inputId}
              aria-label="Message"
              aria-keyshortcuts={cyclesPermission ? 'Shift+Tab' : undefined}
              placeholder={placeholder}
              value={text}
              onChange={(event) => onTextChange(event.target.value)}
              onKeyDown={keydown}
              rows={2}
              disabled={readOnly}
              readOnly={pending}
              aria-busy={pending || undefined}
            />
          </div>
          {attachments.value.length > 0 && (
            <div className="attachment-chips">
              {attachments.value.map((file, index) => (
                <span className="tag" key={index}>
                  {file.name}
                  <button
                    aria-label={`Remove ${file.name}`}
                    disabled={attachments.disabled}
                    onClick={() =>
                      attachments.onChange((images) => images.filter((image) => image !== file))
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div
            className="composer-toolbar"
            role="group"
            aria-label="Message controls"
            onFocusCapture={(event) => {
              const toolbar = event.currentTarget,
                button = event.target.closest('button');
              if (
                !button ||
                !toolbar.contains(button) ||
                toolbar.scrollWidth <= toolbar.clientWidth
              )
                return;
              const control = button.getBoundingClientRect(),
                bounds = toolbar.getBoundingClientRect();
              if (control.right > bounds.right) toolbar.scrollLeft += control.right - bounds.right;
              else if (control.left < bounds.left) toolbar.scrollLeft += control.left - bounds.left;
            }}
          >
            <input
              className="sr-only"
              type="file"
              accept="image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff,.ico,.hdr,.exr,.tga,.pnm,.ppm,.pgm,.pbm,.qoi,.dds,.ff"
              aria-label="Image files"
              tabIndex={-1}
              multiple
              ref={fileInput}
              disabled={attachments.disabled || fileAction.busy}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                void fileAction.run(async () => {
                  const added = await Promise.all(files.map(fileImage));
                  attachments.onChange((images) => [...images, ...added]);
                });
                event.target.value = '';
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Attach images"
              title="Attach images (idle sessions only)"
              disabled={attachments.disabled || fileAction.busy}
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus size={18} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="composer-settings-button"
              aria-label="Session settings"
              aria-haspopup="dialog"
              title="Session settings"
              disabled={settings.disabled}
              data-saving={settings.busy || undefined}
              aria-busy={settings.busy || undefined}
              onClick={settings.open}
            >
              <SettingsIcon className="composer-settings-icon" size={18} aria-hidden="true" />
              <span className="composer-control-label">Settings</span>
            </Button>
            <div className="composer-selectors">
              <PermissionSelect {...permission} />
              <ProfileSelect {...profile} />
            </div>
            <Button
              size="icon"
              variant={stop ? 'destructive' : 'default'}
              className={stop ? 'stop-turn-button' : undefined}
              aria-label={label}
              title={
                stop
                  ? action.busy
                    ? 'Stopping turn…'
                    : `${label} (${shortcutHint('stopTurn')})`
                  : label
              }
              aria-keyshortcuts={stop ? shortcutAttribute('stopTurn') : undefined}
              aria-busy={action.busy || undefined}
              disabled={blocked}
              onClick={action.run}
            >
              <Icon
                size={stop ? 18 : 19}
                fill={stop ? 'currentColor' : 'none'}
                strokeWidth={stop ? 0 : 2}
                aria-hidden="true"
              />
            </Button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

async function fileImage(file: File): Promise<ComposerOptions['images'][number]> {
  if (file.size > 3_750_000)
    throw new Error(`${file.name} is larger than meka’s 3.75 MB image limit.`);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
  return { name: file.name, media_type: file.type || 'application/octet-stream', data };
}
