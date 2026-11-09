import { useAction } from '../components/actions';
import { useShortcut } from '../components/use-shortcut';
import {
  Fragment,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ChevronRight,
  FoldVertical,
  GitBranch,
  MessageCircleQuestion,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Unplug,
} from 'lucide-react';
import { problemText, sessionPath, type Schema } from '../api/client';
import {
  useCan,
  useConnection,
  useResource,
  useRuntime,
  useSettings,
} from '../connections/context';
import type {
  SessionState,
  LiveTool,
  Submission,
  ComposerOptions,
  ImageAttachment,
} from '../session/controller';
import { compactionNote } from '../session/compaction';
import { contextQuestion, rewindableTurns, type ConversationMessage } from '../session/history';
import { isSessionRunning, UnsentMessage } from '../session/controller';
import { useTextDraft } from '../session/drafts';
import { subagentsQuery, useContextPositions, useSessionStates } from '../session/hooks';
import { useMarkSeen } from '../session/unread';
import { useTurnRecords } from '../session/turn-records';
import { Button } from '../components/ui/button';
import { Empty, ErrorNotice, Loading } from '../components/common';
import { NoticeMessage, TurnNotice } from '../components/notice-message';
import { ToolCard } from '../components/tool-card';
import { EditPreview } from '../components/edit-preview';
import { describeRun, isEdit, segments, toolPart, type Part, type Step } from '../session/steps';
import { Steps } from './folded-steps';
import { Markdown, MarkdownPreview } from '../components/markdown';
import { Attachment, InlineAttachment, ImageViewerProvider } from '../components/image-attachment';
import { scrollRegion } from '../components/scrolling';
import { Dialog } from '../components/ui/dialog';
import { ComposerSettingsForm } from './session-settings';
import {
  groupAgentMessages,
  groupLiveMessages,
  liveAfterSaved,
  groupToolResults,
  isInput,
  mentionsInline,
  messageText,
  pendingInboxMessages,
  recoverableSubmissions,
  resendable,
  responseActivityIndicator,
  spawnedAgent,
  speakers,
  type HistoryMessage,
  type LiveGroup,
  type ToolResultBlock,
  type ToolUseBlock,
} from './conversation-history';
import { MessageComposer } from '../components/message-composer';
import { CopyAction, HistoryAction, MessageEditor, TurnActions } from './turn-actions';
import { ChecklistStrip } from './checklist-strip';
import { ContextMeter } from './session-context';
import { TurnSummary } from './turn-summary';
import { focusMessage, useMentions } from '../components/workspace';
import {
  DEFAULT_INPUT_HEIGHT,
  emptyComposerOptions,
  remainingComposerOptions,
} from '../session/composer-options';
/** Where a reader left a conversation: at its latest, or `into` pixels below the top of a saved
 * message, so what loads late above it, such as a diagram, does not move them. */
type Position = { following: boolean; top: number; anchor?: { message: string; into: number } };
const positions = new Map<string, Position>();
function readPosition(node: HTMLElement, following: boolean): Position {
  const top = node.scrollTop;
  if (following) return { following, top };
  // The last saved message that begins at or above the top of the view.
  const origin = node.getBoundingClientRect().top - top;
  const messages = node.querySelectorAll<HTMLElement>('[data-message]');
  let found: HTMLElement | undefined;
  for (let low = 0, high = messages.length - 1; low <= high;) {
    const middle = (low + high) >> 1;
    if (messages[middle]!.getBoundingClientRect().top - origin <= top) {
      found = messages[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  const message = found?.dataset.message;
  if (!found || !message) return { following, top };
  return {
    following,
    top,
    anchor: { message, into: top - found.getBoundingClientRect().top + origin },
  };
}
function placePosition(node: HTMLElement, { top, anchor }: Position) {
  const found = anchor && node.querySelector(`[data-message="${anchor.message}"]`);
  if (!anchor || !found) node.scrollTop = top;
  else
    node.scrollTop +=
      found.getBoundingClientRect().top - node.getBoundingClientRect().top + anchor.into;
}
export function Conversation({ state }: { state: SessionState }) {
  const { api, controller, connection, connectionIssue } = useConnection();
  // A running sub-agent's feed tells which call in this session runs it, and what it is doing.
  // Over HTTP/1.1 a browser holds about six connections to a server, and this session's feed and
  // the server feed take two of them, so only the most recently active two are followed.
  const subagents = useQuery(subagentsQuery(api, connection, state.id));
  const runningSubagents =
    subagents.data?.sessions
      .filter((session) => session.turn_in_flight)
      .slice(0, 2)
      .map((session) => session.id)
      .join(' ') ?? '';
  useEffect(() => {
    for (const id of runningSubagents.split(' ').filter(Boolean)) controller?.watch(id);
  }, [controller, runningSubagents]);
  const runtime = useRuntime();
  const draft = useTextDraft(runtime.storage, connection?.id ?? '', state.id);
  // A path picked in Files is added to the message being written.
  useMentions(draft.setText);
  const profiles = useResource<Schema['ProfilesResponse']>('/v1/profiles');
  const inbox = useResource<Schema['InboxListResponse']>(sessionPath(state.id) + '/inbox');
  const canWithdraw = useCan('sessions:w') && !state.session?.parent_id && !state.deleting;
  const [feedbackError, setFeedbackError] = useState<unknown>();
  // Also marked from the session list, which can be collapsed or hidden.
  useMarkSeen(state.id, state.session?.updated_at);
  const [inputHeight, setInputHeight] = useState(DEFAULT_INPUT_HEIGHT);
  const [resizeGeneration, setResizeGeneration] = useState(0);
  const { showTurnContext, foldSteps, expandThinking } = useSettings();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // A returning reader's place, kept as the conversation lays out until they move themselves.
  const held = useRef<Position>(undefined);
  const release = () => {
    held.current = undefined;
  };
  const lastScroll = useRef({ top: 0, height: 0 });
  // Where the reader was as earlier history was asked for, to keep them there once it comes in.
  const prepending = useRef<{ place: Position; height: number }>(undefined);
  const [showLatest, setShowLatest] = useState(false);
  const [contentBelow, setContentBelow] = useState(false);
  function jumpToLatest() {
    const node = scroller.current;
    if (!node) return;
    held.current = undefined;
    following.current = true;
    node.scrollTop = node.scrollHeight;
    setShowLatest(false);
  }
  function acceptDraft(submitted: string) {
    draft.accepted(submitted);
    setInputHeight(DEFAULT_INPUT_HEIGHT);
    setResizeGeneration((value) => value + 1);
    jumpToLatest();
  }
  const history = useMemo(() => groupToolResults(state.saved?.messages ?? []), [state.saved]);
  const firstShown = state.saved?.messages[0]?.position;
  const messages = useMemo(() => groupAgentMessages(history.messages), [history.messages]);
  // Who says what, for the agent's headings and a reply's actions; see `speakers`.
  const said = useMemo(() => speakers(messages, showTurnContext), [messages, showTurnContext]);
  // What saved history shows already is not shown again.
  const { groups: live } = useMemo(
    () =>
      liveAfterSaved(
        groupLiveMessages(state.blocks, state.submissions),
        state.saved?.messages ?? [],
      ),
    [state.blocks, state.submissions, state.saved],
  );
  const activity = responseActivityIndicator(state, live);
  // Live, the same: the agent's words head a block only after someone else's.
  const liveHeaded = (index: number) =>
    index > 0 ? live[index - 1]!.kind !== 'agent' : !said.agentLast;
  // A compaction's own turn, run between turns, compacts until it ends; once the history holds it,
  // its line is drawn where this one was. Its turn wrote nothing else to the history.
  const ownTurn = state.saved?.messages.filter((message) => message.turn_id === state.turnId);
  const landed = ownTurn?.length === 1 && Boolean(ownTurn[0]!.compaction);
  const waiting =
    (connectionIssue &&
      activity &&
      ['connecting', 'reconnecting', 'disconnected'].includes(activity.status)) ||
    (activity?.status === 'compacting' && landed)
      ? undefined
      : activity;
  const problems = recoverableSubmissions(state.submissions, state.notices);
  // A newer turn puts away what was said before it, since the conversation has moved past it, and
  // the person may put one away themselves.
  const notices = state.notices.filter((notice) => !notice.superseded && !notice.dismissed);
  // A give-up reported below keeps its words on the message without saying why twice.
  const reported = new Set(
    state.notices.flatMap((notice) =>
      notice.event === 'inbox.failed' && notice.itemId ? [notice.itemId] : [],
    ),
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
      recoverable={
        problemKeys.has(submission.key) && !(submission.itemId && reported.has(submission.itemId))
      }
      onAccepted={() => acceptDraft(submission.body.message)}
      onError={setFeedbackError}
    />
  );
  // Below the agent's live words, except a compaction, whose line stands across the conversation.
  const appendActivity =
    waiting && waiting.status !== 'compacting' && live[waiting.index - 1]?.kind === 'agent'
      ? waiting.status
      : undefined;
  // The turn running, whose steps fold only as the agent says more after them; one started
  // elsewhere, and named nowhere here yet, is the one saved history ends in.
  const running = isSessionRunning(state);
  const runningTurn = running
    ? (state.submissions.filter((submission) => submission.state === 'running').at(-1)?.turnId ??
      state.turnId ??
      state.saved?.messages.at(-1)?.turn_id ??
      undefined)
    : undefined;
  // Whether the agent says anything after each live group, and so after all saved history: its
  // steps are done then, whichever group they are in, as a message sent mid-turn splits them.
  const liveSaysAfter = useMemo(() => {
    const after: boolean[] = [];
    let later = false;
    for (let index = live.length - 1; index >= 0; index--) {
      after[index] = later;
      const group = live[index]!;
      if (group.kind === 'agent' && group.blocks.some(({ block }) => block.kind === 'text'))
        later = true;
    }
    return { after, any: later };
  }, [live]);
  const changes = useAction(setFeedbackError);
  const [editing, setEditing] = useState<number>();
  // Read once per history, not on every streamed token.
  const saved = useMemo(() => state.saved?.messages ?? [], [state.saved]);
  // Which turns the context holds is the history's to say, but for those only the context knows.
  const question = useMemo(() => contextQuestion(saved), [saved]);
  // Read only where the actions show, and not while a turn may still take its prompt back.
  const context = useContextPositions(state.id, canWithdraw && !running ? question : undefined);
  const earlier = state.saved?.earlier ?? false;
  const turns = useMemo(
    () => rewindableTurns(saved, { earlier, context }),
    [saved, earlier, context],
  );
  const kinds = useMemo(() => messages.map(turnKind), [messages]);
  // Whether the agent says anything in saved history after each group.
  const savedSaysAfter = useMemo(() => {
    const after: boolean[] = [];
    let later = false;
    for (let position = messages.length - 1; position >= 0; position--) {
      after[position] = later;
      if (
        messages[position]!.some(
          ({ message, blocks }) =>
            message.role === 'assistant' &&
            blocks.some(({ block }) => block.type === 'text' && block.text.trim()),
        )
      )
        later = true;
    }
    return after;
  }, [messages]);
  // Each turn closes under the last group it added, once its record says how it ended.
  const records = useTurnRecords(state);
  const turnEnds = useMemo(() => {
    const ends = new Map<string, number>();
    messages.forEach((group, position) => {
      const turnId = group.at(-1)?.message.turn_id;
      if (turnId) ends.set(turnId, position);
    });
    return ends;
  }, [messages]);
  const latestInput = kinds.lastIndexOf('input');
  const latestReply = kinds.lastIndexOf('reply');
  // History edits are decided on the saved conversation, so none while a turn adds to it.
  const changeable =
    canWithdraw &&
    state.feed === 'connected' &&
    !isSessionRunning(state) &&
    !live.length &&
    !state.loading &&
    !changes.busy;
  const run = (action: () => Promise<unknown>) => void changes.run(action);
  const resend = (turnId: string, message: string, images: ImageAttachment[], skill: string) =>
    run(async () => {
      try {
        await controller?.resend(state.id, turnId, message, images, skill);
        setEditing(undefined);
      } catch (error) {
        if (!(error instanceof UnsentMessage)) throw error;
        // The rewind took the message away with its turn, so it goes where it can be sent again.
        setEditing(undefined);
        draft.setText((value) => (value.trim() ? `${value}\n\n${error.text}` : error.text));
        const options = controller?.draft(state.id) ?? emptyComposerOptions;
        if (error.images.length || error.skill)
          controller?.saveDraft(state.id, {
            ...options,
            images: [...options.images, ...error.images],
            skill: error.skill || options.skill,
          });
        throw new Error(`${error.message} It is back in the message input.`, { cause: error });
      }
    });
  function turnActions(group: HistoryMessage[], position: number) {
    const first = group[0]!;
    const kind = kinds[position];
    // Only a turn the context still holds can be taken back, or branched before.
    const opened = first.message.turn_id;
    const turn = opened ? turns.get(opened) : undefined;
    const turnId = group.at(-1)?.message.turn_id;
    const record = turnId && turnEnds.get(turnId) === position ? records?.get(turnId) : undefined;
    const summary = record?.ended_at ? <TurnSummary turn={record} /> : undefined;
    if (!kind)
      return summary ? { actions: <TurnActions label="Turn" latest summary={summary} /> } : {};
    // A reply that goes on past a compaction's line, or is still being written, shows its actions
    // once, at its end.
    if (kind === 'reply' && (said.goesOn[position] || (runningTurn && turnId === runningTurn)))
      return {};
    const later = (turn?.turns ?? 1) - 1;
    const removed = `${later} later turn${later === 1 ? '' : 's'}`;
    const files = 'Files the agent changed stay changed.';
    if (kind === 'input') {
      const text = messageText([first.message]);
      const again = resendable(first.message);
      const at = first.message.position;
      // A steer Meka folded into a tool round or a nudge is part of the turn, not its opening.
      const opens = turn?.start === first.index;
      return {
        editor: at !== undefined && editing === at && turn && opens && again && (
          <MessageEditor
            initial={again.text}
            images={again.images.length}
            disabled={!changeable}
            confirm={
              later
                ? {
                    title: 'Send the edited message?',
                    description: `Its reply and ${removed} are removed first. ${files}`,
                    action: 'Send',
                  }
                : undefined
            }
            onCancel={() => setEditing(undefined)}
            onSend={(message) => resend(opened!, message, again.images, again.skill)}
          />
        ),
        actions: (
          <TurnActions label="Message actions" latest={position === latestInput} summary={summary}>
            <CopyAction text={text} label="Copy message" onError={setFeedbackError} />
            {canWithdraw && turn && opens && (
              <>
                <HistoryAction
                  icon={<Pencil size={15} />}
                  label="Edit and send again"
                  disabled={!changeable || !again}
                  confirm={undefined}
                  onRun={() => setEditing(at)}
                />
                <HistoryAction
                  icon={<Trash2 size={15} />}
                  label="Delete this turn"
                  danger
                  disabled={!changeable}
                  confirm={{
                    title: 'Delete this turn?',
                    description: `Your message${later ? ', its reply, and ' + removed : ' and its reply'} are removed. ${files}`,
                    action: 'Delete',
                  }}
                  onRun={() => run(async () => controller?.rewind(state.id, opened!))}
                />
              </>
            )}
          </TurnActions>
        ),
      };
    }
    const text = messageText(
      messages
        .slice(said.runs[position] ?? position, position + 1)
        .flat()
        .flatMap(({ message }) => (message.role === 'assistant' ? [message] : [])),
    );
    const opening = turn && saved[turn.start];
    // A turn a compaction cut in two is held from its first round after it, the agent's: its
    // message is in the summary, and there is nothing to send again.
    const again = opening?.role === 'user' ? resendable(opening) : undefined;
    return {
      actions: (
        <TurnActions label="Reply actions" latest={position === latestReply} summary={summary}>
          <CopyAction text={text} label="Copy reply" onError={setFeedbackError} />
          {canWithdraw && turn && (
            <>
              <HistoryAction
                icon={<RotateCcw size={15} />}
                label="Run this turn again"
                disabled={!changeable || !again}
                confirm={
                  later
                    ? {
                        title: 'Run this turn again?',
                        description: `This reply and ${removed} are removed, then your message is sent again. ${files}`,
                        action: 'Run again',
                      }
                    : undefined
                }
                onRun={() => again && resend(opened!, again.text, again.images, again.skill)}
              />
              <HistoryAction
                icon={<GitBranch size={15} />}
                label="Branch into a new session from here"
                disabled={!changeable}
                confirm={undefined}
                onRun={() =>
                  run(async () => {
                    const id = await controller?.branch(state.id, turn.next);
                    if (id) location.hash = '/sessions/' + encodeURIComponent(id);
                  })
                }
              />
            </>
          )}
        </TurnActions>
      ),
    };
  }
  const key = connection?.id + ':' + state.id;
  // Kept as the reader scrolls: once this unmounts, its scroller is detached and reads 0.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const position = positions.get(key);
    following.current = position?.following ?? true;
    held.current = following.current ? undefined : position;
    if (held.current) placePosition(node, held.current);
    else node.scrollTop = node.scrollHeight;
  }, [key]);
  // Earlier history came in above the reader: they stay where they were reading.
  useLayoutEffect(() => {
    const node = scroller.current;
    const asked = prepending.current;
    prepending.current = undefined;
    if (!node || !asked || following.current) return;
    // Above every message there is none to hold to, and one the page joined onto, which starts
    // earlier now, is not where it was: what came in above is scrolled past instead.
    const anchor = asked.place.anchor;
    if (anchor && node.querySelector(`[data-message="${anchor.message}"]`))
      placePosition(node, asked.place);
    else node.scrollTop = asked.place.top + node.scrollHeight - asked.height;
  }, [firstShown]);
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
      // Jump only here, after the frame's scroll events, so a reader's scroll lands first.
      if (following.current) node.scrollTop = node.scrollHeight;
      else if (held.current) placePosition(node, held.current);
      setShowLatest(!following.current);
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
          onPointerDown={release}
          onWheel={release}
          onTouchStart={release}
          onKeyDown={release}
          onScroll={() => {
            const node = scroller.current;
            if (node) {
              const { scrollTop: top, scrollHeight: height } = node;
              const remaining = height - top - node.clientHeight;
              // A held place moves only with the layout under it, which says nothing of the reader.
              if (!held.current) {
                // Resizes move the position too, so only a move up at a steady height counts.
                if (remaining <= 1) following.current = true;
                else if (top < lastScroll.current.top && height === lastScroll.current.height)
                  following.current = false;
                positions.set(key, readPosition(node, following.current));
              }
              lastScroll.current = { top, height };
              if (prepending.current)
                prepending.current = { place: readPosition(node, false), height };
              setShowLatest(!following.current);
              setContentBelow(remaining > 1);
            }
          }}
        >
          <div
            className="conversation-history"
            ref={content}
            onWheel={(event) => {
              // Stop before the scroll lands; a jump in between can make the browser drop it.
              if (event.deltaY < 0 && scroller.current?.scrollTop) following.current = false;
            }}
          >
            <div
              className="conversation-width"
              onClick={(event) => {
                // Opening something shows it where it is, rather than following the latest.
                if (
                  event.target instanceof Element &&
                  event.target.closest('summary, .steps-toggle')
                )
                  following.current = false;
              }}
            >
              {state.saved?.earlier && (
                <HistoryStart
                  key={state.saved.before}
                  root={scroller}
                  onReach={() => {
                    const node = scroller.current;
                    // Where the reader is, so what comes in above does not move them.
                    if (node && !following.current)
                      prepending.current = {
                        place: readPosition(node, false),
                        height: node.scrollHeight,
                      };
                    void controller?.earlier(state.id);
                  }}
                />
              )}
              {/* A new session's first message shows while its empty history loads; the notice
                  would only push it down for a moment. */}
              {state.loading && !state.saved && !live.length && (
                <Loading label="Loading saved conversation…" />
              )}
              {state.saved?.messages.length === 0 &&
                !live.length &&
                !waiting &&
                !notices.length &&
                !recovered.length &&
                !queued.length && <Empty title="Send a message to begin" />}
              {messages.map((group, position) => (
                <Message
                  key={group[0]!.message.position}
                  position={group[0]!.message.position}
                  headed={said.heads[position] ?? true}
                  sessionId={state.id}
                  messages={group}
                  toolResults={history.results}
                  showTurnContext={showTurnContext}
                  fold={foldSteps}
                  ended={
                    !runningTurn ||
                    group.at(-1)?.message.turn_id !== runningTurn ||
                    savedSaysAfter[position]! ||
                    liveSaysAfter.any
                  }
                  hold={showLatest}
                  {...turnActions(group, position)}
                />
              ))}
              {(live.length > 0 || waiting) && (
                <section className="live-preview">
                  {live.map((group, index) => (
                    <Fragment key={group.key}>
                      {waiting?.index === index && !appendActivity && (
                        <WaitingMessage status={waiting.status} headed={liveHeaded(index)} />
                      )}
                      {group.kind === 'user' ? (
                        sentMessage(group.submission)
                      ) : group.kind === 'message' ? (
                        <Message
                          sessionId={state.id}
                          messages={groupToolResults([group.message]).messages}
                          toolResults={noToolResults}
                          showTurnContext={showTurnContext}
                        />
                      ) : (
                        <article
                          className={`message message-assistant${liveHeaded(index) ? '' : ' message-continued'}`}
                        >
                          {liveHeaded(index) && (
                            <MessageHeader
                              author="Agent"
                              status={isSessionRunning(state) ? 'Live' : 'Saving…'}
                            />
                          )}
                          <LiveBlocks
                            blocks={group.blocks}
                            state={state}
                            fold={foldSteps}
                            expandThinking={expandThinking}
                            ended={!running || liveSaysAfter.after[index]!}
                            hold={showLatest}
                          />
                          {appendActivity && waiting?.index === index + 1 && (
                            <AgentActivity status={appendActivity} />
                          )}
                        </article>
                      )}
                    </Fragment>
                  ))}
                  {waiting?.index === live.length && !appendActivity && (
                    <WaitingMessage status={waiting.status} headed={liveHeaded(live.length)} />
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
              {notices.map((notice) => (
                <NoticeMessage
                  key={notice.id}
                  notice={notice}
                  onDismiss={(event) => {
                    controller?.dismissNotice(state.id, notice.id);
                    // From the keyboard, focus goes on to the message rather than the page.
                    if (event.detail === 0) focusMessage();
                  }}
                />
              ))}
              {state.feed === 'unloaded' && (
                <NoticeMessage
                  notice={{
                    level: 'info',
                    text: 'This session isn’t loaded on the server, and loading it takes write access. Live updates start once the server loads it.',
                  }}
                />
              )}
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
            {/* Folding a block can leave nothing below without a scroll that resumes following. */}
            {showLatest && contentBelow && (
              <Button className="jump-latest" variant="secondary" size="sm" onClick={jumpToLatest}>
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
  headed,
}: {
  status: NonNullable<ReturnType<typeof responseActivityIndicator>>['status'];
  /** Whether it heads what the agent says, rather than carrying on from it; see `said`. */
  headed: boolean;
}) {
  if (status === 'compacting') return <CompactingLine />;
  return (
    <article
      className={`message message-assistant agent-waiting${headed ? '' : ' message-continued'}`}
    >
      {headed && <MessageHeader author="Agent" />}
      <AgentActivity status={status} />
    </article>
  );
}
/**
 * A compaction under way, drawn as the line it leaves across the conversation, its two halves drawn
 * in toward the label as what is above them is.
 */
function CompactingLine() {
  return (
    <article className="message message-summary">
      <p className="compaction-rule compaction-running">
        <span className="compaction-label" aria-hidden="true">
          <FoldVertical size={16} />
          Compacting context…
        </span>
        {/* A status region is read out as what is in it changes, so the words come once it is
            there rather than with it. */}
        <span className="sr-only" role="status" ref={announceCompacting} />
      </p>
    </article>
  );
}
/**
 * Writes `text` into a live region a frame after it is drawn, so it is read out. One for each text,
 * made once: a ref made again each render would be attached again, and read out again.
 */
function announce(text: string) {
  return (node: HTMLElement | null) => {
    if (!node) return;
    const frame = requestAnimationFrame(() => (node.textContent = text));
    return () => cancelAnimationFrame(frame);
  };
}
const announceCompacting = announce('Compacting context…');
function AgentActivity({
  status,
}: {
  /** A compaction draws its line instead; see `CompactingLine`. */
  status: Exclude<
    NonNullable<ReturnType<typeof responseActivityIndicator>>['status'],
    'compacting'
  >;
}) {
  const Icon =
    status === 'approval'
      ? ShieldCheck
      : status === 'question'
        ? MessageCircleQuestion
        : status === 'disconnected'
          ? Unplug
          : undefined;
  const label = {
    working: 'Agent is working',
    approval: 'Waiting for approval',
    question: 'Waiting for your answer',
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
/** What Meka wrote to send the agent back to work, kept apart from what the person wrote. */
function Nudge({ kind, text }: { kind: string; text: string }) {
  return (
    <details className="injected">
      <summary>
        {kind === 'checklist'
          ? 'Meka sent the agent back to its checklist'
          : kind === 'visible_reply'
            ? 'Meka asked the agent for a reply it could show'
            : 'Meka sent the agent back to work'}
      </summary>
      <pre className="plain-text">{text}</pre>
    </details>
  );
}
/** Meka's short form of a task or job id, as its own screen says it. */
const shortId = (id: string) => id.slice(0, 8);
/** Background work that finished, reported to the agent by Meka rather than written by anyone. */
function BackgroundReport({ tasks, text }: { tasks: readonly string[]; text: string }) {
  return (
    <details className="injected">
      <summary>
        {tasks.length === 1
          ? `Background task ${shortId(tasks[0]!)} reported`
          : tasks.length
            ? `${tasks.length} background tasks reported: ${tasks.map(shortId).join(', ')}`
            : 'Background tasks reported'}
      </summary>
      <pre className="plain-text">{text}</pre>
    </details>
  );
}
/** A scheduled job's fire, which Meka wrote in the job's name rather than anyone typing it. */
function ScheduledFire({ job, prompt, text }: { job: string; prompt: string; text: string }) {
  return (
    <details className="injected scheduled-fire">
      <summary>
        Scheduled job {shortId(job)} fired: {prompt.replace(/\s+/g, ' ').trim()}
      </summary>
      <pre className="plain-text">{text}</pre>
    </details>
  );
}
/** The top of the history held, which reads the page before it as it comes into view. */
function HistoryStart({
  root,
  onReach,
}: {
  root: RefObject<HTMLElement | null>;
  onReach: () => void;
}) {
  const start = useRef<HTMLDivElement>(null);
  const reach = useEffectEvent(onReach);
  useEffect(() => {
    const element = start.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) reach();
      },
      { root: root.current, rootMargin: '400px 0px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  return <div ref={start} className="history-start" />;
}
/** Who sent a message: the source its inbox items named, when every word came from that one. */
function sender(message: ConversationMessage) {
  const sources = new Set(
    message.content.flatMap((block) =>
      block.type === 'text' || block.type === 'invocation'
        ? ['']
        : block.type === 'inbox'
          ? [block.source ?? '']
          : [],
    ),
  );
  const [source] = sources;
  return (sources.size === 1 && source) || 'You';
}
/** How items fold: what each is, as a part and as a step, its key, the call it is, and itself. */
interface Folding<T> {
  sessionId: string;
  fold: boolean;
  ended: boolean;
  hold: boolean;
  part: (item: T) => Part;
  step: (item: T) => Step;
  key: (item: T) => string;
  call: (item: T) => string | undefined;
  render: (item: T) => ReactNode;
}

/**
 * `items` with their runs of steps in {@link Steps}. A run's React key is its first item's, which
 * stays as it grows; it is remembered by its turn and its first call, which are the same live and
 * saved, the turn telling apart calls a provider names alike in different turns.
 */
function foldItems<T>(items: readonly T[], folding: Folding<T>): ReactNode[] {
  return segments(items.map(folding.part), folding.ended, folding.fold).map((segment) => {
    if (segment.kind === 'item') return folding.render(items[segment.at]!);
    const run = items.slice(segment.from, segment.to + 1);
    const key = folding.key(run[0]!);
    const { text, failed } = describeRun(run.map(folding.step));
    return (
      <Steps
        key={`steps:${key}`}
        id={`${folding.sessionId}:${run.map(folding.call).find(Boolean) ?? key}`}
        finished={segment.finished}
        count={run.length}
        hold={folding.hold}
        label={text}
        failed={failed}
      >
        {run.map(folding.render)}
      </Steps>
    );
  });
}

type LiveItem = Extract<LiveGroup, { kind: 'agent' }>['blocks'][number];

/** The live turn's output, its finished runs of steps folding as it says more: see {@link Steps}. */
function LiveBlocks({
  blocks,
  state,
  fold,
  expandThinking,
  ended,
  hold,
}: {
  blocks: readonly LiveItem[];
  state: SessionState;
  fold: boolean;
  /** Whether the thinking being streamed, the turn's last block, shows open. */
  expandThinking: boolean;
  ended: boolean;
  hold: boolean;
}) {
  const part = ({ block }: LiveItem): Part =>
    block.kind === 'tool'
      ? toolPart(state.tools[block.id]?.name ?? '')
      : block.kind === 'text'
        ? 'words'
        : block.kind === 'notice'
          ? 'other'
          : 'step';
  const step = ({ block }: LiveItem): Step => {
    if (block.kind === 'tool') {
      const tool = state.tools[block.id];
      return { kind: 'tool', name: tool?.name ?? '', failed: tool?.state === 'error' };
    }
    return block.kind === 'thinking' ? { kind: 'thinking' } : { kind: 'note' };
  };
  const render = ({ block, index }: LiveItem) =>
    block.kind === 'tool' ? (
      <Tool key={block.id} tool={state.tools[block.id]} sessionId={state.id} />
    ) : block.kind === 'thinking' ? (
      <Thinking
        key={index}
        text={block.text}
        streaming={expandThinking && !ended && index === state.blocks.length - 1}
        hold={hold}
      />
    ) : block.kind === 'nudge' ? (
      <Nudge key={index} kind={block.nudge} text={block.text} />
    ) : block.kind === 'report' ? (
      <BackgroundReport key={index} tasks={block.tasks} text={block.text} />
    ) : block.kind === 'notice' ? (
      <TurnNotice key={index} notice={block} />
    ) : (
      <Markdown key={index} text={block.text} />
    );
  return foldItems(blocks, {
    sessionId: state.id,
    fold,
    ended,
    hold,
    part,
    step,
    key: ({ block, index }) => (block.kind === 'tool' ? block.id : `live:${index}`),
    call: ({ block }) => (block.kind === 'tool' ? `${state.turnId ?? ''}:${block.id}` : undefined),
    render,
  });
}

/** What a saved block is to folding. */
function savedPart(block: Schema['ContentBlockView']): Part {
  switch (block.type) {
    case 'text':
      return block.text.trim() ? 'words' : 'other';
    case 'thinking':
    case 'redacted_thinking':
    case 'nudge':
    case 'background_report':
    case 'tool_result':
      return 'step';
    case 'tool_use':
      return toolPart(block.name);
    default:
      return 'other';
  }
}

/** A saved step, as its run's line counts it. */
function savedStep(block: Schema['ContentBlockView'], result: ToolResultBlock | undefined): Step {
  if (block.type === 'tool_use')
    return { kind: 'tool', name: block.name, failed: result?.is_error ?? false };
  if (block.type === 'tool_result') return { kind: 'tool', name: '', failed: block.is_error };
  if (block.type === 'nudge' || block.type === 'background_report') return { kind: 'note' };
  return { kind: 'thinking' };
}

/**
 * The agent's thinking, folded to a line. While it is `streaming` it shows open, and folds once it
 * is done: at once, or once a reader scrolled up, `hold`, is back at the latest.
 */
function Thinking({
  text,
  streaming = false,
  hold = false,
}: {
  text: string;
  streaming?: boolean;
  hold?: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  // Opened as it streamed, to fold when it is done; folded or opened by hand, it stays so.
  const [following, setFollowing] = useState(streaming);
  if (streaming && !following) {
    setFollowing(true);
    setOpen(true);
  } else if (!streaming && following && !hold) {
    setFollowing(false);
    setOpen(false);
  }
  return (
    <details
      className="thinking"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
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
/** What a saved group is to the actions under it: a message someone sent, or the agent's turn. */
function turnKind(group: HistoryMessage[]) {
  const message = group[0]?.message;
  if (!message || message.compaction) return;
  if (message.role === 'assistant') return 'reply';
  // A scheduled fire opens its turn with the job's words, which Meka wrote but which are copied,
  // edited, and deleted like a message's.
  if (isInput(message) || message.content.some((block) => block.type === 'scheduled'))
    return 'input';
}
/** For a message the feed delivered whole, which answers no tool call. */
const noToolResults: ReadonlyMap<ToolUseBlock, ToolResultBlock> = new Map();
function Message({
  position,
  headed = true,
  messages,
  sessionId,
  toolResults,
  showTurnContext,
  fold = false,
  ended = true,
  hold = false,
  actions,
  editor,
}: {
  /** Where a saved message sits in the history, which marks it as a place to return to. */
  position?: number | undefined;
  /** For the agent's: whether it heads what the agent says, rather than carrying on from it. */
  headed?: boolean;
  messages: HistoryMessage[];
  sessionId: string;
  toolResults: ReadonlyMap<ToolUseBlock, ToolResultBlock>;
  showTurnContext: boolean;
  /** Whether an agent's finished runs of steps fold: see {@link Steps}. */
  fold?: boolean;
  /** Whether its turn is over, or has said more since, so every run of it is finished. */
  ended?: boolean;
  /** Whether the reader is away from the latest, so runs finishing now wait to fold. */
  hold?: boolean;
  actions?: ReactNode;
  editor?: ReactNode;
}) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const message = messages[0]?.message;
  if (!message) return null;
  // Filter only the rendered blocks; preserve message boundaries, indexes, and saved history.
  // Blank words show nothing, and would part a run of steps.
  const content = messages.flatMap(({ blocks, index: messageIndex }) =>
    mentionsInline(blocks).flatMap(({ block, index }) =>
      (showTurnContext || block.type !== 'turn_context') &&
      !(block.type === 'text' && !block.text.trim())
        ? [{ block, index, messageIndex }]
        : [],
    ),
  );
  if (message.compaction)
    return (
      <article className="message message-summary" data-message={position}>
        {/* A line across the conversation, as Meka's screen draws it: what is above it the agent
            now reads as the summary it opens to. */}
        <aside aria-label="Compaction">
          <details
            className="compaction"
            onToggle={(event) => setSummaryOpen(event.currentTarget.open)}
          >
            <summary className="compaction-rule">
              <span className="compaction-label">
                <FoldVertical size={16} aria-hidden="true" />
                Context compacted
                <ChevronRight className="compaction-chevron" size={14} aria-hidden="true" />
              </span>
            </summary>
            {summaryOpen && (
              <div className="compaction-content">
                <p className="compaction-note">
                  {compactionNote(message.compaction)} Compaction {message.compaction.generation}.
                </p>
                <div className="compaction-text">
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
              </div>
            )}
          </details>
        </aside>
      </article>
    );
  if (!content.length && message.content.length > 0) return null;
  const isUserInput = isInput(message);
  const turnOf = new Map(messages.map(({ index, message }) => [index, message.turn_id ?? '']));
  // Saved messages are known by their place in the history; live ones by their place here.
  const at = new Map(messages.map(({ index, message }) => [index, message.position ?? index]));
  const render = ({ block, index, messageIndex }: (typeof content)[number]) => (
    <ContentBlock
      key={`${at.get(messageIndex)}:${index}`}
      block={block}
      sessionId={sessionId}
      result={block.type === 'tool_use' ? toolResults.get(block) : undefined}
    />
  );
  // Only the agent's turns have steps to fold.
  const body =
    message.role !== 'assistant'
      ? content.map(render)
      : foldItems(content, {
          sessionId,
          fold,
          ended,
          hold,
          part: ({ block }) => savedPart(block),
          step: ({ block }) =>
            savedStep(block, block.type === 'tool_use' ? toolResults.get(block) : undefined),
          key: ({ index, messageIndex }) => `${at.get(messageIndex)}:${index}`,
          call: ({ block, messageIndex }) =>
            block.type === 'tool_use' ? `${turnOf.get(messageIndex)}:${block.id}` : undefined,
          render,
        });
  const continues = !headed && message.role === 'assistant';
  return (
    <article
      className={`message message-${message.role}${isUserInput ? ' message-input' : ''}${continues ? ' message-continued' : ''}`}
      data-message={position}
    >
      {!continues && (
        <MessageHeader
          author={
            message.content.length > 0 &&
            message.content.every((block) => block.type === 'tool_result')
              ? 'Tool'
              : message.role === 'user'
                ? isUserInput
                  ? sender(message)
                  : 'Meka'
                : message.role === 'assistant'
                  ? 'Agent'
                  : message.role
          }
          createdAt={message.created_at}
        />
      )}
      {editor || body}
      {!editor && actions}
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
      {images.map((image, index) =>
        // Sent again by hash, the image is the one the session already holds.
        image.hash ? (
          <Attachment key={index} sessionId={sessionId} hash={image.hash} />
        ) : image.data ? (
          <InlineAttachment
            key={index}
            image={{ media_type: image.media_type ?? '', data: image.data }}
            index={index}
          />
        ) : null,
      )}
      {skill && <p className="muted small">Skill: {skill}</p>}
      {submission.state === 'accepted' && <InboxRetry item={pending} />}
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
      <InboxRetry item={item} />
    </article>
  );
}
/** Why Meka holds a queued message back after its turn failed, and when it runs it again. */
function InboxRetry({ item }: { item: Schema['InboxItemView'] | undefined }) {
  // A session another process holds sets a time too, with no error: nothing failed then.
  const problem = problemText(item?.last_error);
  if (item?.state !== 'pending' || !item.not_before || !problem) return null;
  const at = new Date(item.not_before).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <p className="muted small">
      Next attempt at {at} · {problem}
    </p>
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
      tone="danger"
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
          <summary>Context added by Meka</summary>
          <pre className="plain-text">{block.text}</pre>
        </details>
      );
    case 'thinking':
      return <Thinking text={block.thinking} />;
    case 'nudge':
      return <Nudge kind={block.kind} text={block.text} />;
    case 'inbox':
      return <Markdown text={block.body} />;
    case 'invocation':
      return (
        <>
          {block.directive.trim() && <Markdown text={block.directive} />}
          <p className="muted small">
            {block.kind === 'mcp_prompt' ? 'Prompt' : 'Skill'}: {block.name}
          </p>
        </>
      );
    case 'scheduled':
      return <ScheduledFire job={block.job_id} prompt={block.prompt} text={block.text} />;
    case 'background_report':
      return <BackgroundReport tasks={block.task_ids} text={block.text} />;
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
          // Only a change made shows: one that failed, or never finished, made none.
          preview={
            isEdit(block.name) && result && !result.is_error ? (
              <EditPreview name={block.name} input={block.input} />
            ) : undefined
          }
        >
          {agentCalls.has(block.name) && (
            <SubagentSection
              sessionId={sessionId}
              call={block.id}
              name={block.name}
              input={block.input}
              result={result?.content}
            />
          )}
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
        ) : block.type === 'tool_reference' ? (
          <LoadedTool key={index} name={block.tool_name} />
        ) : (
          <Attachment key={index} sessionId={sessionId} hash={block.hash} />
        ),
      )}
    </ToolOutput>
  );
}
/** A deferred tool the result made callable, which Meka names in place of its schema. */
function LoadedTool({ name }: { name: string }) {
  return (
    <p className="plain-text">
      Loaded <code>{name}</code>
    </p>
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
function Tool({ tool, sessionId }: { tool: LiveTool | undefined; sessionId: string }) {
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
      // A change shows as it is written and made, not once it failed or was stopped.
      preview={
        isEdit(tool.name) && ['composing', 'executing', 'completed'].includes(tool.state) ? (
          <EditPreview name={tool.name} input={tool.input} />
        ) : undefined
      }
    >
      {/* The completion carries the whole output, so the stream gives way to the Result; a call
          that ended without one keeps what streamed. */}
      {tool.output && !['completed', 'error'].includes(tool.state) && (
        <div className="tool-section">
          <h4>Output</h4>
          <ToolOutput label="Tool output">
            <pre className="plain-text">{tool.output}</pre>
          </ToolOutput>
        </div>
      )}
      {agentCalls.has(tool.name) && (
        <SubagentSection
          sessionId={sessionId}
          call={tool.id}
          name={tool.name}
          input={tool.input}
          result={Array.isArray(tool.content) ? tool.content : undefined}
        />
      )}
      {tool.progress && <p>{tool.progress}</p>}
      {['completed', 'error'].includes(tool.state) && (
        <div className="tool-section">
          <h4>Result</h4>
          <ToolOutput>
            {Array.isArray(tool.content) &&
              tool.content.map((content: Schema['ToolResultContentView'], index: number) =>
                content.type === 'text' ? (
                  <pre className="plain-text" key={index}>
                    {content.text}
                  </pre>
                ) : content.type === 'tool_reference' ? (
                  <LoadedTool key={index} name={content.tool_name} />
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
/**
 * The sub-agent an `agent_spawn` or `agent_followup` call runs, and while it runs, the calls it
 * has made. Its own feed names the call; otherwise a follow-up names the sub-agent, perhaps by a
 * unique prefix, and a spawn reports it in its result.
 */
const agentCalls = new Set(['agent_spawn', 'agent_followup']);
function SubagentSection({
  sessionId,
  call,
  name,
  input,
  result,
}: {
  sessionId: string;
  call: string;
  name: string;
  input: unknown;
  result: { type: string; text?: string }[] | undefined;
}) {
  const { api, connection } = useConnection();
  const children = useQuery(subagentsQuery(api, connection, sessionId)).data?.sessions;
  const running = useSessionStates().find(
    ({ spawnedBy }) => spawnedBy?.sessionId === sessionId && spawnedBy.toolCallId === call,
  );
  const named =
    name === 'agent_followup'
      ? (input as { id?: unknown } | null)?.id
      : spawnedAgent(result?.find((item) => item.type === 'text')?.text ?? '');
  const matches =
    typeof named === 'string' ? (children ?? []).filter(({ id }) => id.startsWith(named)) : [];
  const id =
    running?.id ??
    (matches.length === 1
      ? matches[0]!.id
      : typeof named === 'string' && /^[0-9a-f-]{36}$/.test(named)
        ? named
        : undefined);
  if (!id) return null;
  const calls = (running?.blocks ?? []).flatMap((block) => {
    const tool = block.kind === 'tool' ? running?.tools[block.id] : undefined;
    return tool ? [tool.displaySummary ? `${tool.name}: ${tool.displaySummary}` : tool.name] : [];
  });
  return (
    <div className="tool-section">
      <h4>Sub-agent</h4>
      <p>
        <a href={`#/sessions/${encodeURIComponent(id)}`}>
          {children?.find((child) => child.id === id)?.title || 'Open its session'}
        </a>
      </p>
      {calls.length > 0 && <pre className="plain-text">{calls.slice(-20).join('\n')}</pre>}
    </div>
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
      above={<ChecklistStrip items={state.session?.checklist ?? []} />}
      meter={state.session ? <ContextMeter session={state.id} /> : undefined}
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
              : 'Ask Meka to work on something…'
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
          {/* A turn known to have started is reviewed, never sent again. */}
          {!submission.turnId && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!canWrite || action.busy}
              onClick={() =>
                void action.run(async () => {
                  if (await controller?.retrySubmission(sessionId, submission.key)) onAccepted();
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
        </div>
      )}
    </div>
  );
}
