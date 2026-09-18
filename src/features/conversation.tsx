import { useAction } from '../components/actions';
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, X } from 'lucide-react';
import { ApiError, sessionPath, type Schema } from '../api/client';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import type { SessionState, LiveTool, Submission, ComposerOptions } from '../session/controller';
import { useTextDraft } from '../session/drafts';
import { Button } from '../components/ui/button';
import { Empty, ErrorNotice, Json, Loading } from '../components/common';
import { Attachment, Markdown } from '../components/markdown';
import { PermissionSelect } from '../components/ui/permission-select';
import { Dialog } from '../components/ui/dialog';
import { ComposerSettingsForm } from './session-settings';
const positions = new Map<string, { top: number; following: boolean }>();
export function Conversation({ state }: { state: SessionState }) {
  const { controller, connection } = useConnection();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const key = connection?.id + ':' + state.id;
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const position = positions.get(key);
    following.current = position?.following ?? true;
    node.scrollTop = following.current ? node.scrollHeight : (position?.top ?? 0);
    return () => {
      positions.set(key, { top: node.scrollTop, following: following.current });
    };
  }, [key]);
  useEffect(() => {
    const node = scroller.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [state.saved, state.blocks, state.tools]);
  useEffect(() => {
    const node = scroller.current;
    const body = content.current;
    const footer = dock.current;
    const composer = footer?.querySelector<HTMLElement>('.composer-area');
    if (!node || !body || !footer || !composer) return;
    const observer = new ResizeObserver(() => {
      // Keep focused content above the sticky input and match its optional inner scrollbar.
      node.style.setProperty('--composer-height', `${footer.offsetHeight}px`);
      node.style.setProperty(
        '--composer-scrollbar',
        `${composer.offsetWidth - composer.clientWidth}px`,
      );
      if (following.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(body);
    observer.observe(footer);
    observer.observe(composer);
    observer.observe(node);
    return () => observer.disconnect();
  }, [key]);
  return (
    <div className="conversation-wrap">
      <div
        ref={scroller}
        className="conversation-scroll"
        onScroll={() => {
          const node = scroller.current;
          if (node) {
            following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
            setShowLatest(!following.current);
            positions.set(key, { top: node.scrollTop, following: following.current });
          }
        }}
      >
        <div className="conversation-history" ref={content}>
          <div
            className="conversation-width"
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest('summary'))
                following.current = false;
            }}
          >
            {state.offset > 0 && (
              <Button
                variant="secondary"
                onClick={() => {
                  const node = scroller.current;
                  const height = node?.scrollHeight ?? 0;
                  void controller?.earlier(state.id).then(() =>
                    requestAnimationFrame(() => {
                      if (node) node.scrollTop += node.scrollHeight - height;
                    }),
                  );
                }}
              >
                Load earlier messages ({state.offset})
              </Button>
            )}
            {state.loading && !state.saved && <Loading label="Loading saved conversation…" />}
            {state.saved?.messages.length === 0 && !state.blocks.length && (
              <Empty title="Send a message to begin" />
            )}
            {state.saved?.messages.map((message, index) => (
              <Message
                key={`${state.saved?.revision}:${state.offset + index}`}
                sessionId={state.id}
                message={message}
              />
            ))}
            {state.partial && (
              <div className="notice">
                Live replay may be incomplete. Saved conversation and live preview are shown
                separately until the turn is reconciled.
              </div>
            )}
            {state.blocks.length > 0 && (
              <section className="live-preview">
                <p className="live-label">Live response{state.running ? '' : ' · Saving…'}</p>
                {state.blocks.map((block, index) =>
                  block.kind === 'tool' ? (
                    <Tool key={block.id} tool={state.tools[block.id]} />
                  ) : block.kind === 'thinking' ? (
                    <Reasoning key={index} text={block.text} />
                  ) : (
                    <Markdown key={index} text={block.text} />
                  ),
                )}
              </section>
            )}
            {state.notices.length > 0 && (
              <details className="notices">
                <summary>Activity notices ({state.notices.length})</summary>
                {state.notices.map((notice, index) => (
                  <p className="plain-text" key={index}>
                    {notice}
                  </p>
                ))}
              </details>
            )}
            <ErrorNotice error={state.error ? new Error(state.error) : undefined} />
          </div>
        </div>
        <div className="composer-dock" ref={dock}>
          {showLatest && (
            <Button
              className="jump-latest"
              variant="secondary"
              size="sm"
              onClick={() => {
                const node = scroller.current;
                if (node) {
                  following.current = true;
                  node.scrollTop = node.scrollHeight;
                  setShowLatest(false);
                }
              }}
            >
              <ArrowDown size={14} />
              Latest
            </Button>
          )}
          <Composer key={key} state={state} />
        </div>
      </div>
    </div>
  );
}
function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="thinking" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Reasoning</summary>
      {open && <Markdown text={text} />}
    </details>
  );
}
function Message({ message, sessionId }: { message: Schema['MessageView']; sessionId: string }) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  if (message.compaction)
    return (
      <article className="message message-summary">
        <aside className="compaction-marker" aria-label="Compaction boundary">
          <details
            className="tool-card compaction-summary"
            onToggle={(event) => setSummaryOpen(event.currentTarget.open)}
          >
            <summary>
              Conversation summary
              <span className="muted small">Compaction {message.compaction.generation}</span>
            </summary>
            {summaryOpen && (
              <div className="compaction-content">
                <p className="muted small">
                  {message.compaction.replaced_count} messages replaced in the model context.
                  Earlier history is available in transcript export.
                </p>
                {message.content.map((block, index) => (
                  <ContentBlock
                    key={index}
                    sessionId={sessionId}
                    block={
                      // The API marker identifies summaries; remove only its redundant display label.
                      index === 0 && block.type === 'text'
                        ? {
                            ...block,
                            text: block.text.replace(
                              /^\[Conversation summary from session compaction\]\r?\n(?:\r?\n)?/,
                              '',
                            ),
                          }
                        : block
                    }
                  />
                ))}
              </div>
            )}
          </details>
        </aside>
      </article>
    );
  const isUserInput =
    message.role === 'user' &&
    message.content.some((block) => block.type === 'text' || block.type === 'image');
  return (
    <article className={`message message-${message.role}${isUserInput ? ' message-input' : ''}`}>
      <header>
        <span>
          {message.content.length > 0 &&
          message.content.every((block) => block.type === 'tool_result')
            ? 'Tool'
            : message.role === 'user'
              ? 'You'
              : message.role === 'assistant'
                ? 'Meka'
                : message.role}
        </span>
        {message.created_at && (
          <time dateTime={message.created_at}>
            {new Date(message.created_at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        )}
      </header>
      {message.content.map((block, index) => (
        <ContentBlock key={index} block={block} sessionId={sessionId} />
      ))}
    </article>
  );
}
function ContentBlock({
  block,
  sessionId,
}: {
  block: Schema['ContentBlockView'];
  sessionId: string;
}) {
  switch (block.type) {
    case 'text':
      return <Markdown text={block.text} />;
    case 'turn_context':
      return (
        <details className="injected">
          <summary>Context added by meka</summary>
          <pre className="plain-text">{block.text}</pre>
        </details>
      );
    case 'thinking':
      return <Reasoning text={block.thinking} />;
    case 'redacted_thinking':
      return <p className="muted small">Reasoning unavailable.</p>;
    case 'image':
      return <Attachment sessionId={sessionId} hash={block.hash} mediaType={block.media_type} />;
    case 'tool_use':
      return (
        <details className="tool-card">
          <summary>
            <span className="tool-symbol">⌘</span>
            {block.name}
            <span className="muted small">Arguments</span>
          </summary>
          <Json value={block.input} />
        </details>
      );
    case 'tool_result':
      return (
        <details className={`tool-card ${block.is_error ? 'tool-error' : ''}`}>
          <summary>
            {block.is_error ? 'Tool error' : 'Tool result'}
            <span className="muted small">{block.tool_use_id}</span>
          </summary>
          {block.content.map((content, index) =>
            content.type === 'text' ? (
              <pre className="plain-text" key={index}>
                {content.text}
              </pre>
            ) : (
              <Attachment
                key={index}
                sessionId={sessionId}
                hash={content.hash}
                mediaType={content.media_type}
              />
            ),
          )}
        </details>
      );
  }
}
function Tool({ tool }: { tool: LiveTool | undefined }) {
  if (!tool) return null;
  return (
    <details className={`tool-card ${tool.state === 'error' ? 'tool-error' : ''}`}>
      <summary>
        <span className="tool-symbol">⌘</span>
        {tool.name}
        <span className="badge">{tool.state}</span>
      </summary>
      <h4>Arguments</h4>
      <Json value={tool.input} />
      {tool.output && <pre className="plain-text">{tool.output}</pre>}
      {tool.activity && <pre className="plain-text">{tool.activity}</pre>}
      {tool.progress && <p>{tool.progress}</p>}
      {['completed', 'error'].includes(tool.state) && (
        <>
          <h4>Result</h4>
          {Array.isArray(tool.content) &&
            tool.content.map((content: { type: string; text?: string }, index: number) =>
              content.type === 'text' ? (
                <pre className="plain-text" key={index}>
                  {content.text}
                </pre>
              ) : (
                <p className="muted small" key={index}>
                  Image preview available after this turn finishes.
                </p>
              ),
            )}
        </>
      )}
    </details>
  );
}
async function fileImage(file: File): Promise<Schema['ImageInput'] & { name: string }> {
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
const emptyComposerOptions: ComposerOptions = {
  images: [],
  skill: '',
  retention: 'keep',
  mode: 'steer',
  source: '',
};
const subscribeToNothing = () => () => {};
function Composer({ state }: { state: SessionState }) {
  const { connection, controller, api, info } = useConnection();
  const runtime = useRuntime();
  const canWrite = useCan('sessions:w');
  const draft = useTextDraft(runtime.storage, connection?.id ?? '', state.id);
  const options =
    useSyncExternalStore(controller?.subscribe ?? subscribeToNothing, () =>
      controller?.draft(state.id),
    ) ?? emptyComposerOptions;
  const { images, skill, retention, mode, source } = options;
  function updateOptions(
    patch: Partial<ComposerOptions> | ((current: ComposerOptions) => Partial<ComposerOptions>),
  ) {
    const current = controller?.draft(state.id) ?? emptyComposerOptions;
    controller?.saveDraft(state.id, {
      ...current,
      ...(typeof patch === 'function' ? patch(current) : patch),
    });
  }
  function setImages(
    value:
      | ComposerOptions['images']
      | ((current: ComposerOptions['images']) => ComposerOptions['images']),
  ) {
    updateOptions((current) => ({
      images: typeof value === 'function' ? value(current.images) : value,
    }));
  }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const action = useAction();
  const settingsAction = useAction();
  const mutableSettings =
    canWrite && !state.session?.parent_id && Boolean(state.session) && !state.deleting;
  const fileInput = useRef<HTMLInputElement>(null);
  const direct = images.length > 0 || Boolean(skill) || retention !== 'keep';
  const uncertain = state.submissions.find((s) => s.state === 'uncertain');
  const pending = state.submissions.some((s) => s.state === 'sending');
  const blocked =
    !canWrite ||
    Boolean(state.session?.parent_id) ||
    state.feed !== 'connected' ||
    (direct && state.running) ||
    pending ||
    settingsAction.busy ||
    state.settingsPending ||
    state.deleting ||
    Boolean(uncertain);
  async function send() {
    await action.run(async () => {
      if (blocked || !controller) return;
      const submitted = draft.text;
      const ok = direct
        ? await controller.submit(
            state.id,
            {
              message: submitted,
              stream: false,
              images: images.map(({ data, media_type }) => ({ data, media_type })),
              options: { ...(skill ? { skill } : {}), unanswered_message: retention },
            },
            'turn',
          )
        : await controller.submit(
            state.id,
            { message: submitted, class: mode, ...(source ? { source } : {}) },
            'inbox',
          );
      if (ok) {
        draft.accepted(submitted);
        updateOptions((current) => ({
          images: current.images.filter((image) => !images.includes(image)),
          skill: current.skill === skill ? '' : current.skill,
        }));
      }
    });
  }
  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!blocked && (draft.text.trim() || direct)) void send();
    }
  }
  const inbox = useResource<Schema['InboxListResponse']>(sessionPath(state.id) + '/inbox');
  const hint = !canWrite
    ? 'Read only. Sending requires sessions:w.'
    : state.session?.parent_id
      ? 'Sub-agent sessions are driven by their parent.'
      : direct
        ? state.running
          ? 'Send when the session is idle.'
          : skill
            ? `Skill: ${skill}`
            : ''
        : state.feed !== 'connected'
          ? 'Connecting session feed…'
          : mode === 'followup'
            ? 'Queue'
            : mode === 'interrupt'
              ? 'Interrupt and send'
              : '';
  const status = state.deleting
    ? 'Deleting session…'
    : state.settingsPending
      ? 'Saving settings…'
      : state.running
        ? 'Working'
        : state.feed === 'connected'
          ? ''
          : state.feed;
  return (
    <div className="composer-area">
      <div className="conversation-width">
        {state.submissions.length > 0 && (
          <details
            className="submission-list"
            open={Boolean(uncertain) || state.submissions.at(-1)?.state === 'failed'}
          >
            <summary>Message delivery · {state.submissions.at(-1)?.state}</summary>
            {state.submissions.slice(-8).map((submission) => (
              <SubmissionStatus
                key={submission.key}
                submission={submission}
                sessionId={state.id}
                onAccepted={() => draft.accepted(submission.body.message)}
              />
            ))}
          </details>
        )}
        {inbox.data && inbox.data.items.length > 0 && (
          <details>
            <summary>Inbox ({inbox.data.items.length})</summary>
            {inbox.data.items.map((item) => (
              <div key={item.id} className="inbox-item">
                <span>
                  {item.class} · {item.state} · {item.source}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canWrite || item.state !== 'pending' || action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      try {
                        await api?.mutate('DELETE', sessionPath(state.id) + '/inbox/' + item.id);
                      } catch (error) {
                        if (!(error instanceof ApiError && error.status === 404)) throw error;
                      }
                      await inbox.refetch();
                    })
                  }
                >
                  Withdraw
                </Button>
              </div>
            ))}
          </details>
        )}
        {draft.conflict && (
          <div className="notice">
            <div>
              <p>This draft changed in another tab. Choose which version to keep.</p>
              <div className="actions">
                <Button size="sm" variant="secondary" onClick={() => draft.resolve(false)}>
                  Keep mine
                </Button>
                <Button size="sm" variant="secondary" onClick={() => draft.resolve(true)}>
                  Use other tab
                </Button>
              </div>
            </div>
          </div>
        )}
        <ErrorNotice error={action.error} />
        <ErrorNotice error={settingsAction.error} />
        {(settingsAction.busy || state.settingsPending) && (
          <span className="sr-only" role="status">
            Saving session settings…
          </span>
        )}
        <div className="composer">
          <textarea
            aria-label="Message"
            placeholder={
              state.running ? 'Steer the agent as it works…' : 'Ask meka to work on something…'
            }
            value={draft.text}
            onChange={(event) => draft.setText(event.target.value)}
            onKeyDown={keydown}
            rows={3}
            disabled={!canWrite || Boolean(state.session?.parent_id) || state.deleting}
          />
          {images.length > 0 && (
            <div className="attachment-chips">
              {images.map((file, index) => (
                <span className="tag" key={index}>
                  {file.name}
                  <button
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setImages(images.filter((_, i) => index !== i))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="composer-toolbar" role="group" aria-label="Message controls">
            <input
              className="sr-only"
              type="file"
              accept="image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff,.ico,.hdr,.exr,.tga,.pnm,.ppm,.pgm,.pbm,.qoi,.dds,.ff"
              aria-label="Image files"
              tabIndex={-1}
              multiple
              ref={fileInput}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                void action.run(async () => {
                  const added = await Promise.all(files.map(fileImage));
                  setImages((current) => [...current, ...added]);
                });
                event.target.value = '';
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Attach images"
              title="Attach images (idle sessions only)"
              disabled={!canWrite || pending || state.deleting}
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
              disabled={!state.session || state.settingsPending || state.deleting}
              onClick={() => setSettingsOpen(true)}
            >
              Settings
            </Button>
            <PermissionSelect
              value={state.session?.permission ?? undefined}
              options={info?.enabled_permissions ?? []}
              disabled={!mutableSettings || settingsAction.busy || state.settingsPending}
              onChange={(permission) =>
                void settingsAction.run(async () =>
                  controller?.patchSettings(state.id, { permission }),
                )
              }
            />
            <Button
              size="icon"
              aria-label={
                direct
                  ? 'Send images or skill'
                  : mode === 'followup'
                    ? 'Queue message'
                    : mode === 'interrupt'
                      ? 'Interrupt and send'
                      : 'Send message'
              }
              disabled={blocked || (!draft.text.trim() && !images.length && !skill)}
              onClick={() => void send()}
            >
              <ArrowUp size={19} />
            </Button>
          </div>
        </div>
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen} title="Session settings">
          {settingsOpen && state.session && (
            <ComposerSettingsForm
              session={state.session}
              options={{ mode, skill, retention, source }}
              hasImages={images.length > 0}
              running={state.running}
              onSaved={(values) => {
                updateOptions(values);
                setSettingsOpen(false);
              }}
            />
          )}
        </Dialog>
        {(hint || status) && (
          <div className="composer-hint">
            <span>{hint}</span>
            <span>{status}</span>
          </div>
        )}
      </div>
    </div>
  );
}
function SubmissionStatus({
  submission,
  sessionId,
  onAccepted,
}: {
  submission: Submission;
  sessionId: string;
  onAccepted: () => void;
}) {
  const { controller } = useConnection();
  const action = useAction();
  return (
    <div className="submission">
      <p>
        <span className="badge">{submission.state}</span>
        {submission.delivery === 'delivered' && (
          <span className="muted small"> Read by the model · </span>
        )}{' '}
        {submission.body.message.slice(0, 120)}
      </p>
      {submission.error && <p className="muted small">{submission.error}</p>}
      {submission.state === 'uncertain' && (
        <div className="actions wrap">
          {submission.kind === 'inbox' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  if (await controller?.retryInbox(sessionId, submission.key)) onAccepted();
                })
              }
            >
              Retry same submission
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => void controller?.refresh(sessionId)}>
            Inspect saved state
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => controller?.resolveUncertain(sessionId, submission.key)}
          >
            I reviewed the outcome
          </Button>
          {submission.kind === 'turn' && (
            <p className="muted small">
              A direct turn may still be running. Its retry cache does not survive a server restart.
              Review the saved conversation before choosing to submit again.
            </p>
          )}
        </div>
      )}
      <ErrorNotice error={action.error} />
    </div>
  );
}
