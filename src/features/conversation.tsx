import { useAction } from '../components/actions';
import { useShortcut } from '../components/use-shortcut';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ArrowDown, ShieldCheck, Unplug } from 'lucide-react';
import { sessionPath, type Schema } from '../api/client';
import {
  useCan,
  useConnection,
  useResource,
  useRuntime,
  useSettings,
} from '../connections/context';
import type { SessionState, LiveTool, Submission, ComposerOptions } from '../session/controller';
import { isSessionRunning } from '../session/controller';
import { useTextDraft } from '../session/drafts';
import { Button } from '../components/ui/button';
import { Empty, ErrorNotice, Loading } from '../components/common';
import { NoticeMessage } from '../components/notice-message';
import { ToolCard } from '../components/tool-card';
import { Markdown, MarkdownPreview } from '../components/markdown';
import { Attachment, InlineAttachment, ImageViewerProvider } from '../components/image-attachment';
import { scrollRegion } from '../components/scrolling';
import { Dialog } from '../components/ui/dialog';
import { ComposerSettingsForm } from './session-settings';
import {
  groupAgentMessages,
  groupLiveMessages,
  groupToolResults,
  pendingInboxMessages,
  responseActivityIndicator,
  type HistoryMessage,
  type ToolResultBlock,
  type ToolUseBlock,
} from './conversation-history';
import { MessageComposer } from '../components/message-composer';
import {
  DEFAULT_INPUT_HEIGHT,
  emptyComposerOptions,
  remainingComposerOptions,
} from '../session/composer-options';
const positions = new Map<string, { top: number; following: boolean }>();
export function Conversation({ state }: { state: SessionState }) {
  const { controller, connection, connectionIssue } = useConnection();
  const runtime = useRuntime();
  const draft = useTextDraft(runtime.storage, connection?.id ?? '', state.id);
  const profiles = useResource<Schema['ProfilesResponse']>('/v1/profiles');
  const inbox = useResource<Schema['InboxListResponse']>(sessionPath(state.id) + '/inbox');
  const canWithdraw = useCan('sessions:w') && !state.session?.parent_id && !state.deleting;
  const [feedbackError, setFeedbackError] = useState<unknown>();
  const [inputHeight, setInputHeight] = useState(DEFAULT_INPUT_HEIGHT);
  const [resizeGeneration, setResizeGeneration] = useState(0);
  function acceptDraft(submitted: string) {
    draft.accepted(submitted);
    setInputHeight(DEFAULT_INPUT_HEIGHT);
    setResizeGeneration((value) => value + 1);
  }
  const { showTurnContext } = useSettings();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [contentBelow, setContentBelow] = useState(false);
  const history = useMemo(() => groupToolResults(state.saved?.messages ?? []), [state.saved]);
  const messages = useMemo(() => groupAgentMessages(history.messages), [history.messages]);
  const live = useMemo(
    () => groupLiveMessages(state.blocks, state.submissions),
    [state.blocks, state.submissions],
  );
  const activity = responseActivityIndicator(state, live);
  const waiting =
    connectionIssue &&
    activity &&
    ['connecting', 'reconnecting', 'disconnected'].includes(activity.status)
      ? undefined
      : activity;
  const problems = state.submissions.filter(
    (submission) =>
      submission.state === 'uncertain' ||
      (submission === state.submissions.at(-1) &&
        submission.state === 'failed' &&
        !state.notices.some(
          (notice) =>
            notice.event === 'turn.failed' && notice.turnId && notice.turnId === submission.turnId,
        )),
  );
  const problemKeys = new Set(problems.map((submission) => submission.key));
  const liveKeys = new Set(live.flatMap((group) => (group.kind === 'user' ? [group.key] : [])));
  const recovered = problems.filter((submission) => !liveKeys.has(submission.key));
  const queued = pendingInboxMessages(
    inbox.data?.items ?? [],
    state.submissions,
    new Set([...liveKeys, ...problemKeys]),
  );
  const sentMessage = (submission: Submission, pending?: Schema['InboxItemView']) => (
    <SentMessage
      key={submission.key}
      submission={submission}
      sessionId={state.id}
      pending={pending ?? inbox.data?.items.find((item) => item.id === submission.itemId)}
      canWithdraw={canWithdraw}
      recoverable={problemKeys.has(submission.key)}
      onAccepted={() => acceptDraft(submission.body.message)}
      onError={setFeedbackError}
    />
  );
  const appendActivity = waiting && live[waiting.index - 1]?.kind === 'agent';
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
  }, [state.saved, state.blocks, state.tools, state.submissions]);
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
      setContentBelow(node.scrollHeight - node.scrollTop - node.clientHeight > 1);
    });
    observer.observe(body);
    observer.observe(footer);
    observer.observe(composer);
    observer.observe(node);
    return () => observer.disconnect();
  }, [key]);
  return (
    <ImageViewerProvider onReturnFocus={() => scroller.current?.focus({ preventScroll: true })}>
      <div className="conversation-wrap">
        <div
          ref={scroller}
          className="conversation-scroll"
          role="region"
          aria-label="Conversation"
          tabIndex={-1}
          onScroll={() => {
            const node = scroller.current;
            if (node) {
              const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
              following.current = remaining < 120;
              setShowLatest(!following.current);
              setContentBelow(remaining > 1);
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
              {state.saved?.messages.length === 0 &&
                !live.length &&
                !waiting &&
                !state.notices.length &&
                !recovered.length &&
                !queued.length && <Empty title="Send a message to begin" />}
              {messages.map((group) => (
                <Message
                  key={`${state.saved?.revision}:${state.offset + group[0]!.index}`}
                  sessionId={state.id}
                  messages={group}
                  offset={state.offset}
                  toolResults={history.results}
                  showTurnContext={showTurnContext}
                />
              ))}
              {state.partial && (
                <div className="notice replay-notice">
                  Live replay may be incomplete. Saved conversation and live preview are shown
                  separately until the turn is reconciled.
                </div>
              )}
              {(live.length > 0 || waiting) && (
                <section className="live-preview">
                  {live.map((group, index) => (
                    <Fragment key={group.key}>
                      {waiting?.index === index && !appendActivity && (
                        <WaitingMessage status={waiting.status} />
                      )}
                      {group.kind === 'user' ? (
                        sentMessage(group.submission)
                      ) : (
                        <article className="message message-assistant">
                          <MessageHeader
                            author="Agent"
                            status={isSessionRunning(state) ? 'Live' : 'Saving…'}
                          />
                          {group.blocks.map(({ block, index }) =>
                            block.kind === 'tool' ? (
                              <Tool key={block.id} tool={state.tools[block.id]} />
                            ) : block.kind === 'thinking' ? (
                              <Thinking key={index} text={block.text} />
                            ) : (
                              <Markdown key={index} text={block.text} />
                            ),
                          )}
                          {waiting?.index === index + 1 && (
                            <AgentActivity status={waiting.status} />
                          )}
                        </article>
                      )}
                    </Fragment>
                  ))}
                  {waiting?.index === live.length && !appendActivity && (
                    <WaitingMessage status={waiting.status} />
                  )}
                </section>
              )}
              {recovered.map((submission) => sentMessage(submission))}
              {queued.map(({ item, submission }) =>
                submission ? (
                  sentMessage(submission, item)
                ) : (
                  <InboxMessage
                    key={item.id}
                    sessionId={state.id}
                    item={item}
                    canWithdraw={canWithdraw}
                    onError={setFeedbackError}
                  />
                ),
              )}
              {state.notices.map((notice) => (
                <NoticeMessage key={notice.id} notice={notice} />
              ))}
              {draft.conflict && (
                <div className="notice">
                  <div>
                    <p>This draft changed in another tab. Choose which version to keep.</p>
                    <div className="message-actions">
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
              <ErrorNotice error={state.error} />
              <ErrorNotice error={feedbackError} />
              <ErrorNotice error={profiles.error ?? inbox.error} />
            </div>
          </div>
          <div className="composer-dock" ref={dock} data-content-below={contentBelow}>
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
            <Composer
              key={key}
              state={state}
              draft={draft}
              profiles={profiles.data?.profiles ?? []}
              onError={setFeedbackError}
              inputHeight={inputHeight}
              onResize={setInputHeight}
              resizeGeneration={resizeGeneration}
              onAccepted={acceptDraft}
            />
          </div>
        </div>
      </div>
    </ImageViewerProvider>
  );
}
function WaitingMessage({
  status,
}: {
  status: NonNullable<ReturnType<typeof responseActivityIndicator>>['status'];
}) {
  return (
    <article className="message message-assistant agent-waiting">
      <MessageHeader author="Agent" />
      <AgentActivity status={status} />
    </article>
  );
}
function AgentActivity({
  status,
}: {
  status: NonNullable<ReturnType<typeof responseActivityIndicator>>['status'];
}) {
  const Icon = status === 'approval' ? ShieldCheck : status === 'disconnected' ? Unplug : undefined;
  const label = {
    working: 'Agent is working',
    approval: 'Waiting for approval',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    disconnected: 'Connection interrupted',
  }[status];
  return (
    <p className="agent-waiting-status" data-status={status} role="status">
      {status === 'working' ? (
        <>
          <span className="agent-working-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        <>
          {Icon && <Icon size={16} aria-hidden="true" />}
          {label}
        </>
      )}
    </p>
  );
}
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="thinking" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Thinking...
        {!open && text.trim() && (
          <span className="thinking-preview">
            {' '}
            <MarkdownPreview text={text} />
          </span>
        )}
      </summary>
      {open && <Markdown text={text} />}
    </details>
  );
}
function Message({
  messages,
  sessionId,
  toolResults,
  offset,
  showTurnContext,
}: {
  messages: HistoryMessage[];
  sessionId: string;
  toolResults: ReadonlyMap<ToolUseBlock, ToolResultBlock>;
  offset: number;
  showTurnContext: boolean;
}) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const message = messages[0]?.message;
  if (!message) return null;
  // Filter only the rendered blocks; preserve message boundaries, indexes, and saved history.
  const content = messages.flatMap(({ blocks, index: messageIndex }) =>
    blocks.flatMap(({ block, index }) =>
      showTurnContext || block.type !== 'turn_context' ? [{ block, index, messageIndex }] : [],
    ),
  );
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
                {content.map(({ block, index }) => (
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
  if (!content.length && message.content.length > 0) return null;
  const isUserInput =
    message.role === 'user' &&
    message.content.some((block) => block.type === 'text' || block.type === 'image');
  return (
    <article className={`message message-${message.role}${isUserInput ? ' message-input' : ''}`}>
      <MessageHeader
        author={
          message.content.length > 0 &&
          message.content.every((block) => block.type === 'tool_result')
            ? 'Tool'
            : message.role === 'user'
              ? 'You'
              : message.role === 'assistant'
                ? 'Agent'
                : message.role
        }
        createdAt={message.created_at}
      />
      {content.map(({ block, index, messageIndex }) => (
        <ContentBlock
          key={`${offset + messageIndex}:${index}`}
          block={block}
          sessionId={sessionId}
          result={block.type === 'tool_use' ? toolResults.get(block) : undefined}
        />
      ))}
    </article>
  );
}
function MessageHeader({
  author,
  createdAt,
  status,
  actions,
}: {
  author: string;
  createdAt?: string | null | undefined;
  status?: string | undefined;
  actions?: ReactNode;
}) {
  return (
    <header>
      <span>{author}</span>
      {createdAt && (
        <time dateTime={createdAt}>
          {new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      )}
      {(status || actions) && (
        <div className="message-meta">
          {status && (
            <span className="message-delivery" role="status">
              {status}
            </span>
          )}
          {actions}
        </div>
      )}
    </header>
  );
}
function SentMessage({
  submission,
  sessionId,
  pending,
  canWithdraw,
  recoverable,
  onAccepted,
  onError,
}: {
  submission: Submission;
  sessionId: string;
  pending: Schema['InboxItemView'] | undefined;
  canWithdraw: boolean;
  recoverable: boolean;
  onAccepted: () => void;
  onError: (error: unknown) => void;
}) {
  const images = 'images' in submission.body ? (submission.body.images ?? []) : [];
  const skill = 'options' in submission.body ? submission.body.options?.skill : undefined;
  return (
    <article className="message message-user message-input">
      <MessageHeader
        author="You"
        createdAt={submission.createdAt}
        status={
          {
            sending: 'Sending…',
            accepted:
              'class' in submission.body
                ? submission.body.class === 'followup'
                  ? 'Queued'
                  : submission.body.class === 'interrupt'
                    ? 'Interrupting…'
                    : 'Steering…'
                : '',
            running: '',
            delivered: '',
            completed: '',
            uncertain: 'Delivery unknown',
            reviewed: 'Outcome reviewed',
            failed: 'Failed',
            withdrawn: 'Withdrawn',
            canceled: 'Canceled',
          }[submission.state]
        }
        actions={
          submission.kind === 'inbox' &&
          submission.itemId &&
          submission.state === 'accepted' &&
          (pending ? pending.state === 'pending' : submission.delivery === 'pending') && (
            <WithdrawMessage
              sessionId={sessionId}
              itemId={submission.itemId}
              disabled={!canWithdraw}
              onError={onError}
            />
          )
        }
      />
      {submission.body.message && <Markdown text={submission.body.message} />}
      {images.map((image, index) => (
        <InlineAttachment key={index} image={image} index={index} />
      ))}
      {skill && <p className="muted small">Skill: {skill}</p>}
      {recoverable && (
        <SubmissionRecovery
          submission={submission}
          sessionId={sessionId}
          onAccepted={onAccepted}
          onError={onError}
        />
      )}
    </article>
  );
}
function InboxMessage({
  sessionId,
  item,
  canWithdraw,
  onError,
}: {
  sessionId: string;
  item: Schema['InboxItemView'];
  canWithdraw: boolean;
  onError: (error: unknown) => void;
}) {
  return (
    <article className="message message-user message-input">
      <MessageHeader
        author={item.source || 'Queued message'}
        createdAt={item.created_at}
        status="Queued"
        actions={
          <WithdrawMessage
            sessionId={sessionId}
            itemId={item.id}
            disabled={!canWithdraw}
            onError={onError}
          />
        }
      />
      <p className="muted">Queued message · text unavailable</p>
    </article>
  );
}
function WithdrawMessage({
  sessionId,
  itemId,
  disabled,
  onError,
}: {
  sessionId: string;
  itemId: string;
  disabled: boolean;
  onError: (error: unknown) => void;
}) {
  const { controller } = useConnection();
  const action = useAction(onError);
  return (
    <Button
      className="message-withdraw"
      size="sm"
      variant="ghost"
      disabled={disabled || action.busy}
      onClick={() => void action.run(async () => controller?.withdrawInbox(sessionId, itemId))}
    >
      Withdraw
    </Button>
  );
}
function ContentBlock({
  block,
  sessionId,
  result,
}: {
  block: Schema['ContentBlockView'];
  sessionId: string;
  result?: ToolResultBlock | undefined;
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
      return <Thinking text={block.thinking} />;
    case 'redacted_thinking':
      return <p className="muted small">Thinking unavailable.</p>;
    case 'image':
      return <Attachment sessionId={sessionId} hash={block.hash} />;
    case 'tool_use':
      return (
        <ToolCard
          name={block.name}
          input={block.input}
          status={result ? (result.is_error ? 'Error' : 'Completed') : 'Arguments'}
          isError={result?.is_error ?? false}
        >
          {result && (
            <div className="tool-section">
              <h4>Result</h4>
              <ToolResultContent content={result.content} sessionId={sessionId} />
            </div>
          )}
        </ToolCard>
      );
    case 'tool_result':
      return (
        <details className={`tool-card ${block.is_error ? 'tool-error' : ''}`}>
          <summary>
            {block.is_error ? 'Tool error' : 'Tool result'}
            <span className="muted small tool-reference">{block.tool_use_id}</span>
          </summary>
          <ToolResultContent content={block.content} sessionId={sessionId} />
        </details>
      );
  }
}
function ToolResultContent({
  content,
  sessionId,
}: {
  content: Schema['ToolResultContentView'][];
  sessionId: string;
}) {
  return (
    <ToolOutput>
      {content.map((block, index) =>
        block.type === 'text' ? (
          <pre className="plain-text" key={index}>
            {block.text}
          </pre>
        ) : (
          <Attachment key={index} sessionId={sessionId} hash={block.hash} />
        ),
      )}
    </ToolOutput>
  );
}
function ToolOutput({ children, label = 'Tool result' }: { children: ReactNode; label?: string }) {
  return (
    <div
      className="tool-output"
      tabIndex={0}
      role="group"
      aria-label={label}
      onKeyDown={scrollRegion}
    >
      {children}
    </div>
  );
}
function Tool({ tool }: { tool: LiveTool | undefined }) {
  if (!tool) return null;
  return (
    <ToolCard
      name={tool.name}
      input={tool.input}
      displaySummary={tool.displaySummary}
      status={
        {
          composing: 'Composing',
          executing: 'Running',
          completed: 'Completed',
          error: 'Error',
          ended: 'Ended',
        }[tool.state]
      }
      isError={tool.state === 'error'}
    >
      {tool.output && (
        <div className="tool-section">
          <h4>Output</h4>
          <ToolOutput label="Tool output">
            <pre className="plain-text">{tool.output}</pre>
          </ToolOutput>
        </div>
      )}
      {tool.activity && <pre className="plain-text">{tool.activity}</pre>}
      {tool.progress && <p>{tool.progress}</p>}
      {['completed', 'error'].includes(tool.state) && (
        <div className="tool-section">
          <h4>Result</h4>
          <ToolOutput>
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
          </ToolOutput>
        </div>
      )}
    </ToolCard>
  );
}
const subscribeToNothing = () => () => {};
function Composer({
  state,
  draft,
  profiles,
  onError,
  inputHeight,
  onResize,
  resizeGeneration,
  onAccepted,
}: {
  state: SessionState;
  draft: ReturnType<typeof useTextDraft>;
  profiles: Schema['ProfileView'][];
  onError: (error: unknown) => void;
  inputHeight: number;
  onResize: (height: number) => void;
  resizeGeneration: number;
  onAccepted: (submitted: string) => void;
}) {
  const { controller, info } = useConnection();
  const canWrite = useCan('sessions:w');
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
  const action = useAction(onError);
  const cancelAction = useAction(onError);
  const settingsAction = useAction(onError);
  const mutableSettings =
    canWrite && !state.session?.parent_id && Boolean(state.session) && !state.deleting;
  const permissions = info?.enabled_permissions ?? [];
  const settingsSaving = settingsAction.busy || state.settingsPending;
  const permissionDisabled = !mutableSettings || settingsSaving;
  const running = isSessionRunning(state);
  const direct = images.length > 0 || Boolean(skill) || retention !== 'keep';
  const uncertain = state.submissions.find((s) => s.state === 'uncertain');
  const pending = state.submissions.some((s) => s.state === 'sending');
  const hasText = Boolean(draft.text.trim());
  const hasMessage = hasText || images.length > 0 || Boolean(skill);
  const showStop = running && !hasText;
  const actionKind = showStop
    ? 'stop'
    : !running || direct
      ? 'send'
      : mode === 'followup'
        ? 'queue'
        : mode === 'interrupt'
          ? 'interrupt'
          : 'steer';
  const observedTurn = Boolean(
    state.turnId || state.submissions.some((s) => s.state === 'running' && s.turnId),
  );
  const stopDisabled =
    !canWrite ||
    !controller ||
    Boolean(state.session?.parent_id) ||
    state.deleting ||
    !observedTurn ||
    cancelAction.busy;
  const profileLocked = running || pending || Boolean(uncertain);
  const profileDisabled = !mutableSettings || settingsSaving || profileLocked || !profiles.length;
  const blocked =
    !canWrite ||
    Boolean(state.session?.parent_id) ||
    state.feed !== 'connected' ||
    (direct && running) ||
    pending ||
    settingsSaving ||
    state.deleting ||
    Boolean(uncertain);
  async function send() {
    await action.run(async () => {
      if (blocked || !hasMessage || !controller) return;
      const submitted = draft.text;
      const ok = await controller.submitMessage(state.id, submitted, options);
      if (ok) {
        onAccepted(submitted);
        updateOptions((current) => remainingComposerOptions(current, options));
      }
    });
  }
  async function stop() {
    if (!running || stopDisabled || !controller) return;
    await cancelAction.run(() => controller.cancel(state.id));
  }
  useShortcut('stopTurn', () => void stop(), running && !stopDisabled);
  function changePermission(permission: string) {
    if (permissionDisabled || !permissions.includes(permission)) return;
    void settingsAction.run(async () => controller?.patchSettings(state.id, { permission }));
  }
  function changeProfile(profile: string) {
    if (
      profileDisabled ||
      profile === state.session?.profile ||
      !profiles.some((option) => option.name === profile)
    )
      return;
    void settingsAction.run(async () => controller?.patchSettings(state.id, { profile }));
  }
  return (
    <MessageComposer
      text={draft.text}
      onTextChange={draft.setText}
      readOnly={!canWrite || Boolean(state.session?.parent_id) || state.deleting}
      focusId={state.id}
      inputHeight={inputHeight}
      onResize={onResize}
      resizeGeneration={resizeGeneration}
      placeholder={
        !canWrite || state.session?.parent_id
          ? 'Read-only session'
          : state.feed !== 'connected'
            ? 'Waiting for session connection…'
            : running
              ? mode === 'followup'
                ? 'Queue a message…'
                : mode === 'interrupt'
                  ? 'Interrupt with a message…'
                  : 'Steer the agent as it works…'
              : 'Ask meka to work on something…'
      }
      permission={{
        value: state.session?.permission ?? undefined,
        options: permissions,
        disabled: permissionDisabled,
        busy: mutableSettings && settingsSaving,
        onChange: changePermission,
      }}
      profile={{
        value: state.session?.profile,
        profiles,
        disabled: profileDisabled,
        busy: mutableSettings && !profileLocked && settingsSaving,
        locked: profileLocked,
        onChange: changeProfile,
      }}
      attachments={{
        value: images,
        disabled: !canWrite || Boolean(state.session?.parent_id) || pending || state.deleting,
        onChange: setImages,
      }}
      action={{
        kind: actionKind,
        disabled: showStop ? stopDisabled : blocked || !hasMessage,
        busy: showStop ? cancelAction.busy : action.busy,
        run: () => void (showStop ? stop() : send()),
      }}
      settings={{
        disabled: !state.session || settingsSaving || state.deleting,
        busy: Boolean(state.session) && !state.deleting && settingsSaving,
        open: () => setSettingsOpen(true),
      }}
      onError={onError}
    >
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen} title="Session settings">
        {settingsOpen && state.session && (
          <ComposerSettingsForm
            session={state.session}
            options={{ mode, skill, retention, source }}
            hasImages={images.length > 0}
            running={running}
            onSaved={(values) => {
              updateOptions(values);
              setSettingsOpen(false);
            }}
          />
        )}
      </Dialog>
    </MessageComposer>
  );
}
function SubmissionRecovery({
  submission,
  sessionId,
  onAccepted,
  onError,
}: {
  submission: Submission;
  sessionId: string;
  onAccepted: () => void;
  onError: (error: unknown) => void;
}) {
  const { controller } = useConnection();
  const canWrite = useCan('sessions:w');
  const action = useAction(onError);
  return (
    <div className="submission-recovery">
      {submission.error && (
        <NoticeMessage
          notice={{
            level: submission.state === 'uncertain' ? 'warning' : 'error',
            text: submission.error,
          }}
        />
      )}
      {submission.state === 'uncertain' && (
        <div className="message-actions">
          {submission.kind === 'inbox' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!canWrite || action.busy}
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
              Review the saved conversation before sending again. Streaming turns cannot be safely
              retried automatically.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
