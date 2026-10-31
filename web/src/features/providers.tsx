import { Fragment, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Ellipsis, GripVertical, KeyRound, LogIn, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useAction } from '../components/actions';
import {
  useCan,
  useConnection,
  useResource,
  useRuntime,
  useSettings,
} from '../connections/context';
import { segment, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { SwitchField } from '../components/ui/switch';
import { ConfirmAction, ErrorNotice, Field, Loading } from '../components/common';
import { useSortable } from '../components/sortable';
import { useOverlayPadding } from '../components/visual-viewport';
import { BrowserLogin } from './browser-login';
import {
  BACKENDS,
  backendLabel,
  createAccountBody,
  createProfileBody,
  isSubscription,
  patchProfileBody,
  profileDraft,
  providerGroups,
  readsAccountKey,
  readsProfileKey,
  renameInOrder,
  type AccountDraft,
  type ProfileDraft,
  type ProviderGroup,
} from './providers-model';

/** What the page has open, one at a time. */
type Opened =
  | { kind: 'new-account' }
  | { kind: 'new-profile'; account: string }
  | { kind: 'edit-profile'; name: string }
  | { kind: 'rename-account'; name: string }
  | { kind: 'sign-in'; account: Schema['AccountView'] }
  | { kind: 'remove-profile' | 'remove-account' | 'remove-credential'; name: string };

const removals = {
  'remove-profile': {
    title: 'Remove profile',
    description: (name: string) =>
      `Remove “${name}”? Sessions on it can’t resume until they move to another profile.`,
    path: (name: string) => `/v1/profiles/${segment(name)}`,
    order: 'profiles',
  },
  'remove-account': {
    title: 'Remove account',
    description: (name: string) =>
      `Remove “${name}” and its stored credential? meka refuses while a profile uses it.`,
    path: (name: string) => `/v1/accounts/${segment(name)}`,
    order: 'accounts',
  },
  'remove-credential': {
    title: 'Remove credential',
    description: (name: string) => `Remove the credential stored as “${name}”?`,
    path: (name: string) => `/v1/accounts/${segment(name)}`,
    order: undefined,
  },
} as const;

/**
 * meka's accounts, which hold what a provider signs in with, each with the profiles that run on it
 * beneath, a line apiece so a long list reads at a glance.
 */
export function ProvidersPage() {
  const { api } = useConnection();
  const runtime = useRuntime();
  const canRead = useCan('config:r');
  const canWrite = useCan('config:w');
  const { providerOrder } = useSettings();
  const profiles = useResource<Schema['ProfilesResponse']>('/v1/profiles');
  const accounts = useResource<Schema['AccountsResponse']>('/v1/accounts', undefined, canRead);
  const [opened, setOpened] = useState<Opened>();
  // What opened a dialog takes the focus back once none is open, if it is still there.
  const current = useRef<Opened>(undefined);
  const opener = useRef<HTMLElement>(null);
  const show = (next: Opened | undefined) => {
    current.current = next;
    setOpened(next);
  };
  const open = (next: Opened) => (trigger: HTMLElement) => {
    opener.current = trigger;
    show(next);
  };
  // A save that ends after its dialog was closed leaves whatever is open now alone.
  const settle = (from: Opened | undefined, next?: Opened) => {
    if (current.current === from) show(next);
  };
  const dialog = {
    onOpenChange: (value: boolean) => {
      if (!value) show(undefined);
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      if (!current.current && opener.current?.isConnected)
        opener.current.focus({ preventScroll: true });
    },
  };
  const writable = !canWrite ? 'Requires config:w' : undefined;
  const editable = writable ?? (!canRead ? 'Requires config:r' : undefined);
  const all = profiles.data?.profiles ?? [];
  const listed = accounts.data?.accounts;
  const orphans = accounts.data?.orphaned_credentials ?? [];
  // Shown once both lists are in, so profiles do not move as their accounts arrive.
  const ready = Boolean(profiles.data && (listed || !canRead || accounts.error));
  const groups = ready ? providerGroups(listed, all, providerOrder) : [];
  // Saved whole, so the order holds every account and profile as they now stand.
  const reorder = (profiles: string[], accounts = groups.map((group) => group.name)) =>
    runtime.storage.providerOrder({ accounts, profiles });
  const accountSort = useSortable(
    groups.map((group) => group.name),
    (accounts) =>
      reorder(
        groups.flatMap((group) => group.profiles.map((profile) => profile.name)),
        accounts,
      ),
  );
  const ordered = groups.flatMap((group) => group.profiles);
  const orderedAccounts =
    listed && groups.flatMap((group) => (group.account ? [group.account] : []));
  const editing = opened?.kind === 'edit-profile' ? opened.name : undefined;
  const creating = opened?.kind === 'new-profile' ? opened.account : undefined;
  const renaming = opened?.kind === 'rename-account' ? opened.name : undefined;
  const signingIn = opened?.kind === 'sign-in' ? opened.account : undefined;
  const removing =
    opened?.kind === 'remove-profile' ||
    opened?.kind === 'remove-account' ||
    opened?.kind === 'remove-credential'
      ? opened
      : undefined;
  const removal = removals[removing?.kind ?? 'remove-profile'];
  return (
    <div className="page settings-page">
      <header className="page-heading">
        <h1>Providers</h1>
        <div className="actions">
          {ready && !listed && (
            <Button
              variant="secondary"
              disabled={!canWrite}
              title={writable}
              onClick={(event) => open({ kind: 'new-profile', account: '' })(event.currentTarget)}
            >
              <Plus size={16} />
              New profile
            </Button>
          )}
          <Button
            disabled={!canWrite}
            title={writable}
            onClick={(event) => open({ kind: 'new-account' })(event.currentTarget)}
          >
            <Plus size={16} />
            New account
          </Button>
        </div>
      </header>
      {!canRead && <p className="muted small">Reading accounts requires config:r.</p>}
      <ErrorNotice error={profiles.error} />
      <ErrorNotice error={accounts.error} />
      {!ready && !profiles.error && <Loading />}
      {ready && !groups.length && !orphans.length && !accounts.error && (
        <p className="muted small">
          {listed
            ? 'No accounts yet. An account is what meka signs in to a provider with.'
            : 'No profiles yet.'}
        </p>
      )}
      {(groups.length > 0 || orphans.length > 0) && (
        <section className="panel provider-list" aria-label="Accounts and profiles">
          {groups.map((group) => (
            <AccountGroup
              key={group.name}
              group={group}
              listed={Boolean(listed)}
              canWrite={canWrite}
              writable={writable}
              editable={editable}
              open={open}
              sort={accountSort}
              movable={groups.length > 1}
              onReorder={(names) =>
                reorder(
                  groups.flatMap((other) =>
                    other.name === group.name
                      ? names
                      : other.profiles.map((profile) => profile.name),
                  ),
                )
              }
            />
          ))}
          {orphans.map((name) => (
            <div className="provider-group" key={`orphan:${name}`}>
              <div className="provider-row">
                <span className="drag-space" />
                <span className="provider-name">
                  <strong title={name}>{name}</strong>
                </span>
                <div className="provider-rest">
                  <span className="provider-meta">A stored credential no account uses.</span>
                  <RowMenu
                    label={`More for ${name}`}
                    items={[
                      {
                        label: 'Remove',
                        icon: <Trash2 size={14} />,
                        title: writable,
                        disabled: !canWrite,
                        danger: true,
                        onSelect: open({ kind: 'remove-credential', name }),
                      },
                    ]}
                  />
                </div>
              </div>
            </div>
          ))}
        </section>
      )}
      <Dialog open={opened?.kind === 'new-account'} {...dialog} title="New account">
        {opened?.kind === 'new-account' && (
          <AccountForm
            onSaved={async (account) => {
              await runtime.queries.invalidateQueries();
              // A subscription is added signed out; its sign-in is the next step.
              settle(
                opened,
                isSubscription(account.backend) ? { kind: 'sign-in', account } : undefined,
              );
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={signingIn !== undefined}
        {...dialog}
        title={`${signingIn && !isSubscription(signingIn.backend) ? 'Change key for' : 'Sign in to'} ${signingIn?.name ?? 'account'}`}
      >
        {signingIn && (
          <AccountSignIn
            account={signingIn}
            onDone={async () => {
              await runtime.queries.invalidateQueries();
              settle(opened);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={renaming !== undefined}
        {...dialog}
        title="Rename account"
        description="Its profiles and stored credential move with it."
      >
        {renaming !== undefined && (
          <RenameAccount
            name={renaming}
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              settle(opened);
            }}
          />
        )}
      </Dialog>
      <Dialog open={creating !== undefined} {...dialog} title="New profile" wide>
        {creating !== undefined && (
          <ProfileForm
            preset={creating}
            profiles={ordered}
            accounts={orderedAccounts}
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              settle(opened);
            }}
          />
        )}
      </Dialog>
      <Dialog open={editing !== undefined} {...dialog} title={`Edit ${editing ?? 'profile'}`} wide>
        {editing !== undefined && (
          <EditProfile
            name={editing}
            profiles={ordered}
            accounts={orderedAccounts}
            onSaved={async () => {
              // Closed first, so a renamed profile's old entry is not read again.
              flushSync(() => settle(opened));
              await runtime.queries.invalidateQueries();
            }}
          />
        )}
      </Dialog>
      <ConfirmAction
        open={removing !== undefined}
        {...dialog}
        title={removal.title}
        description={removal.description(removing?.name ?? '')}
        onConfirm={async () => {
          if (!removing || !api) return;
          await api.mutate('DELETE', removal.path(removing.name));
          // Gone from the order too, so one added later under its name starts at the end.
          if (removal.order) {
            const order = runtime.storage.getSnapshot().providerOrder;
            runtime.storage.providerOrder({
              ...order,
              [removal.order]: order[removal.order].filter((name) => name !== removing.name),
            });
          }
          await runtime.queries.invalidateQueries();
        }}
      />
    </div>
  );
}

/** An account's row, then its profiles', each moved by its handle. */
function AccountGroup({
  group: { name, account, backend, profiles },
  listed,
  canWrite,
  writable,
  editable,
  open,
  sort,
  movable,
  onReorder,
}: {
  group: ProviderGroup;
  /** Whether meka's accounts were read, so one missing from them is not configured. */
  listed: boolean;
  canWrite: boolean;
  writable: string | undefined;
  editable: string | undefined;
  open: (next: Opened) => (trigger: HTMLElement) => void;
  sort: ReturnType<typeof useSortable>;
  movable: boolean;
  onReorder: (profiles: string[]) => void;
}) {
  const profileSort = useSortable(
    profiles.map((profile) => profile.name),
    onReorder,
  );
  return (
    <div className="provider-group" role="group" aria-label={name} {...sort.item(name)}>
      <div className="provider-row">
        {movable ? (
          <DragHandle label={name} {...sort.handle(name)} />
        ) : (
          <span className="drag-space" />
        )}
        <span className="provider-name">
          <strong title={name}>{name}</strong>
          {account && <SignedIn account={account} />}
        </span>
        <div className="provider-rest">
          <span className="provider-meta">
            {account || !listed ? backendLabel(backend) : 'Not configured'}
            {account?.base_url && ` · ${account.base_url}`}
          </span>
          <div className="actions">
            {account && account.authenticated !== 'yes' && (
              <Button
                variant="ghost"
                disabled={!canWrite}
                title={writable}
                onClick={(event) => open({ kind: 'sign-in', account })(event.currentTarget)}
              >
                <SignInLabel account={account} />
              </Button>
            )}
            {(account || !listed) && (
              <Button
                variant="ghost"
                size="icon"
                disabled={!canWrite}
                aria-label={`New profile on ${name}`}
                title={writable ?? 'New profile'}
                onClick={(event) =>
                  open({ kind: 'new-profile', account: name })(event.currentTarget)
                }
              >
                <Plus size={16} />
              </Button>
            )}
            {account && (
              <RowMenu
                label={`More for ${name}`}
                items={[
                  ...(account.authenticated === 'yes'
                    ? [
                        {
                          label: isSubscription(account.backend) ? 'Sign in again' : 'Change key',
                          icon: isSubscription(account.backend) ? (
                            <LogIn size={14} />
                          ) : (
                            <KeyRound size={14} />
                          ),
                          title: writable,
                          disabled: !canWrite,
                          onSelect: open({ kind: 'sign-in', account }),
                        },
                      ]
                    : []),
                  {
                    label: 'Rename',
                    icon: <Pencil size={14} />,
                    title: writable,
                    disabled: !canWrite,
                    onSelect: open({ kind: 'rename-account', name }),
                  },
                  {
                    label: 'Remove',
                    icon: <Trash2 size={14} />,
                    title: writable,
                    disabled: !canWrite,
                    danger: true,
                    onSelect: open({ kind: 'remove-account', name }),
                  },
                ]}
              />
            )}
          </div>
        </div>
      </div>
      {profiles.map((profile) => (
        <div
          className="provider-row provider-profile"
          key={profile.name}
          {...profileSort.item(profile.name)}
        >
          {profiles.length > 1 ? (
            <DragHandle label={profile.name} {...profileSort.handle(profile.name)} />
          ) : (
            <span className="drag-space" />
          )}
          <span className="provider-name">
            <button
              type="button"
              className="provider-open"
              disabled={Boolean(editable)}
              title={editable ?? profile.name}
              onClick={(event) =>
                open({ kind: 'edit-profile', name: profile.name })(event.currentTarget)
              }
            >
              {profile.name}
            </button>
            {profile.active && <span className="badge">Default</span>}
          </span>
          <div className="provider-rest">
            <span className="provider-meta">
              {profile.model ?? 'No model'}
              {!profile.vision && ' · No images'}
              {profile.fallbacks?.length ? ` · Falls back to ${profile.fallbacks.join(', ')}` : ''}
            </span>
            <RowMenu
              label={`More for ${profile.name}`}
              items={[
                {
                  label: 'Edit',
                  icon: <Pencil size={14} />,
                  title: editable,
                  disabled: Boolean(editable),
                  onSelect: open({ kind: 'edit-profile', name: profile.name }),
                },
                {
                  label: 'Remove',
                  icon: <Trash2 size={14} />,
                  title: writable,
                  disabled: !canWrite,
                  danger: true,
                  onSelect: open({ kind: 'remove-profile', name: profile.name }),
                },
              ]}
            />
          </div>
        </div>
      ))}
      {!profiles.length && (
        <p className="provider-row provider-empty">
          <span className="drag-space" />
          <span className="provider-name">No profiles</span>
        </p>
      )}
    </div>
  );
}

/** Keeps a renamed account or profile where it was put. */
function useRenameInOrder() {
  const runtime = useRuntime();
  return (kind: 'accounts' | 'profiles', from: string, to: string) =>
    runtime.storage.providerOrder(
      renameInOrder(runtime.storage.getSnapshot().providerOrder, kind, from, to),
    );
}

/** What moves a row: dragged, or the arrow keys while it has the focus. */
function DragHandle({
  label,
  ...props
}: { label: string } & ReturnType<ReturnType<typeof useSortable>['handle']>) {
  return (
    <button
      type="button"
      className="drag-handle"
      aria-label={`Move ${label}`}
      title="Drag to reorder"
      {...props}
    >
      <GripVertical size={14} aria-hidden="true" />
    </button>
  );
}

function SignedIn({ account }: { account: Schema['AccountView'] }) {
  if (account.authenticated === 'yes') return <span className="badge success">Signed in</span>;
  if (account.authenticated === 'unreadable')
    return (
      <span className="badge danger" title="meka can’t read its stored credential">
        Unreadable
      </span>
    );
  return <span className="badge">Not signed in</span>;
}

function SignInLabel({ account }: { account: Schema['AccountView'] }) {
  return isSubscription(account.backend) ? (
    <>
      <LogIn size={14} />
      Sign in
    </>
  ) : (
    <>
      <KeyRound size={14} />
      Change key
    </>
  );
}

interface MenuItem {
  label: string;
  icon: ReactNode;
  onSelect: (trigger: HTMLElement) => void;
  disabled?: boolean;
  title?: string | undefined;
  danger?: boolean;
}

/** A row's other actions, behind one button so a row stays a line. */
function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const collisionPadding = useOverlayPadding();
  const trigger = useRef<HTMLButtonElement>(null);
  // The dialog an item opens keeps the focus the menu would hand back to its button.
  const chosen = useRef(false);
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button ref={trigger} variant="ghost" size="icon" aria-label={label} title="More">
          <Ellipsis size={16} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu-panel"
          align="end"
          sideOffset={4}
          collisionPadding={collisionPadding}
          onCloseAutoFocus={(event) => {
            if (chosen.current) event.preventDefault();
            chosen.current = false;
          }}
        >
          {items.map((item, index) => (
            <Fragment key={item.label}>
              {item.danger && index > 0 && <DropdownMenu.Separator className="menu-separator" />}
              <DropdownMenu.Item
                className={`menu-item ${item.danger ? 'menu-item-danger' : ''}`}
                disabled={item.disabled ?? false}
                title={item.title}
                onSelect={() => {
                  chosen.current = true;
                  if (trigger.current) item.onSelect(trigger.current);
                }}
              >
                {item.icon}
                {item.label}
              </DropdownMenu.Item>
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function EditProfile({
  name,
  ...props
}: {
  name: string;
  profiles: Schema['ProfileView'][];
  accounts: Schema['AccountView'][] | undefined;
  onSaved: () => Promise<void>;
}) {
  const detail = useResource<Schema['ProfileDetailView']>(
    `/v1/profiles/${segment(name)}`,
    undefined,
    true,
    false,
  );
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (!detail.data) return <Loading />;
  return <ProfileForm initial={detail.data} {...props} />;
}

const optionLabels: Record<string, string> = {
  '': 'Default',
  true: 'On',
  false: 'Off',
};

function ProfileForm({
  initial,
  preset,
  profiles,
  accounts,
  onSaved,
}: {
  initial?: Schema['ProfileDetailView'];
  /** The account a new profile starts on. */
  preset?: string;
  profiles: Schema['ProfileView'][];
  accounts: Schema['AccountView'][] | undefined;
  onSaved: () => Promise<void>;
}) {
  const { api } = useConnection();
  const action = useAction();
  const rename = useRenameInOrder();
  const [start] = useState(() => profileDraft(initial));
  const [draft, setDraft] = useState(() => ({
    ...start,
    account: start.account || preset || accounts?.[0]?.name || '',
  }));
  const backend = initial
    ? initial.backend
    : accounts?.find((account) => account.name === draft.account)?.backend;
  const set = (patch: Partial<ProfileDraft>) => setDraft((old) => ({ ...old, ...patch }));
  const reads = (key: string) => readsProfileKey(backend, key);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      if (!initial) {
        await api.mutate('POST', '/v1/profiles', createProfileBody(draft, backend));
      } else {
        const path = `/v1/profiles/${segment(initial.name)}`;
        const patch = patchProfileBody(start, draft, backend);
        if (Object.keys(patch).length) await api.mutate('PATCH', path, patch);
        // meka takes a rename on its own, after the settings it moves with.
        if (draft.name.trim() !== initial.name) {
          await api.mutate('PATCH', path, {
            name: draft.name.trim(),
          } satisfies Schema['PatchProfileRequest']);
          rename('profiles', initial.name, draft.name.trim());
        }
      }
      await onSaved();
    });
  }
  const others = profiles.filter(
    (profile) => profile.name !== initial?.name && !draft.fallbacks.includes(profile.name),
  );
  const tristate = (
    key: 'vision' | 'cache_control' | 'encrypted_reasoning' | 'reasoning_summary',
    label: string,
    hint?: string,
  ) => (
    <Field label={label} hint={hint}>
      <select value={draft[key]} onChange={(event) => set({ [key]: event.target.value })}>
        {['', 'true', 'false'].map((value) => (
          <option key={value} value={value}>
            {optionLabels[value]}
          </option>
        ))}
      </select>
    </Field>
  );
  const count = (
    key: 'context_window' | 'max_output_tokens' | 'max_request_bytes' | 'thinking_budget',
    label: string,
  ) => (
    <Field label={label}>
      <input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        placeholder="Default"
        value={draft[key]}
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </Field>
  );
  const choice = (
    key: 'deferred_tools' | 'thinking' | 'thinking_display',
    label: string,
    values: string[],
  ) => (
    <Field label={label}>
      <select value={draft[key]} onChange={(event) => set({ [key]: event.target.value })}>
        <option value="">Default</option>
        {values.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="form-stack" disabled={action.busy}>
        <div className="form-grid">
          <Field label="Name">
            <input
              required
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="work"
            />
          </Field>
          <Field label="Account" hint={initial ? 'Another account is another profile.' : undefined}>
            {accounts && !initial ? (
              <select
                required
                value={draft.account}
                onChange={(event) => set({ account: event.target.value })}
              >
                {accounts.map((account) => (
                  <option key={account.name} value={account.name}>
                    {account.name} · {backendLabel(account.backend)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                required
                disabled={Boolean(initial)}
                value={draft.account}
                onChange={(event) => set({ account: event.target.value })}
              />
            )}
          </Field>
          <Field label="Model">
            <input
              required
              spellCheck={false}
              value={draft.model}
              onChange={(event) => set({ model: event.target.value })}
              placeholder={
                backend?.startsWith('openai') || backend === 'chatgpt-subscription'
                  ? 'gpt-6-astra'
                  : 'claude-opus-5-5'
              }
            />
          </Field>
          {(draft.fallbacks.length > 0 || others.length > 0) && (
            <Field label="Fallbacks">
              <div className="fallback-list">
                {others.length > 0 && (
                  <select
                    aria-label="Add a fallback"
                    value=""
                    onChange={(event) =>
                      set({ fallbacks: [...draft.fallbacks, event.target.value] })
                    }
                  >
                    <option value="">Add a fallback…</option>
                    {others.map((profile) => (
                      <option key={profile.name} value={profile.name}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                )}
                {draft.fallbacks.map((name) => (
                  <span className="tag" key={name}>
                    {name}
                    <button
                      type="button"
                      className="tag-remove"
                      aria-label={`Remove ${name}`}
                      onClick={() => set({ fallbacks: draft.fallbacks.filter((f) => f !== name) })}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </Field>
          )}
        </div>
        <details open>
          <summary>Advanced</summary>
          <div className="form-grid">
            {count('context_window', 'Context window')}
            {count('max_output_tokens', 'Max output tokens')}
            {count('max_request_bytes', 'Max request bytes')}
            <Field label="Effort">
              <input
                list="profile-effort"
                placeholder="Default"
                value={draft.effort}
                onChange={(event) => set({ effort: event.target.value })}
              />
            </Field>
            {tristate('vision', 'Images')}
            {reads('deferred_tools') &&
              choice('deferred_tools', 'Deferred tools', ['native', 'append'])}
            {reads('thinking') && choice('thinking', 'Thinking', ['adaptive', 'budgeted', 'off'])}
            {reads('thinking_budget') &&
              (draft.thinking === 'budgeted' || draft.thinking_budget) &&
              count('thinking_budget', 'Thinking budget')}
            {reads('thinking_display') &&
              choice('thinking_display', 'Thinking display', ['summarized', 'updates', 'redacted'])}
            {reads('cache_control') && tristate('cache_control', 'Cache breakpoint')}
            {reads('encrypted_reasoning') && tristate('encrypted_reasoning', 'Encrypted reasoning')}
            {reads('reasoning_summary') && tristate('reasoning_summary', 'Reasoning summary')}
          </div>
          <datalist id="profile-effort">
            {['low', 'medium', 'high', 'xhigh', 'max'].map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </details>
        <SwitchField
          label="Default profile"
          checked={draft.makeDefault}
          disabled={start.makeDefault}
          title={start.makeDefault ? 'Make another profile the default to change it' : undefined}
          onCheckedChange={(checked) => set({ makeDefault: checked })}
        />
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy}>
            {action.busy ? 'Saving…' : initial ? 'Save' : 'Add profile'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function AccountForm({ onSaved }: { onSaved: (account: Schema['AccountView']) => Promise<void> }) {
  const { api } = useConnection();
  const action = useAction();
  const [draft, setDraft] = useState<AccountDraft>({
    name: '',
    backend: 'anthropic-messages',
    base_url: '',
    api_key: '',
    client_id: '',
    oauth_token_url: '',
    interleaved_thinking: '',
    prompt_cache_key: '',
    stream_usage: '',
    max_tool_name_bytes: '',
  });
  const set = (patch: Partial<AccountDraft>) => setDraft((old) => ({ ...old, ...patch }));
  const subscription = isSubscription(draft.backend);
  const toggle = (
    key: 'interleaved_thinking' | 'prompt_cache_key' | 'stream_usage',
    label: string,
  ) =>
    readsAccountKey(draft.backend, key) && (
      <Field label={label}>
        <select value={draft[key]} onChange={(event) => set({ [key]: event.target.value })}>
          {['', 'true', 'false'].map((value) => (
            <option key={value} value={value}>
              {optionLabels[value]}
            </option>
          ))}
        </select>
      </Field>
    );
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      const account = await api.mutate<Schema['AccountView']>(
        'POST',
        '/v1/accounts',
        createAccountBody(draft),
      );
      await onSaved(account);
    });
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="form-stack" disabled={action.busy}>
        <Field label="Name">
          <input
            required
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
            placeholder="anthropic"
          />
        </Field>
        <Field label="Backend">
          <select value={draft.backend} onChange={(event) => set({ backend: event.target.value })}>
            {BACKENDS.map((backend) => (
              <option key={backend.id} value={backend.id}>
                {backend.label}
              </option>
            ))}
          </select>
        </Field>
        {!subscription && (
          <Field label="API key">
            <input
              required
              type="password"
              autoComplete="off"
              value={draft.api_key}
              onChange={(event) => set({ api_key: event.target.value })}
            />
          </Field>
        )}
        <Field label="Base URL">
          <input
            type="url"
            spellCheck={false}
            placeholder="Provider’s own endpoint"
            value={draft.base_url}
            onChange={(event) => set({ base_url: event.target.value })}
          />
        </Field>
        <details>
          <summary>Advanced</summary>
          <div className="form-stack">
            {subscription && (
              <>
                <Field label="OAuth client ID">
                  <input
                    spellCheck={false}
                    placeholder="Default"
                    value={draft.client_id}
                    onChange={(event) => set({ client_id: event.target.value })}
                  />
                </Field>
                <Field label="OAuth token URL">
                  <input
                    type="url"
                    spellCheck={false}
                    placeholder="Default"
                    value={draft.oauth_token_url}
                    onChange={(event) => set({ oauth_token_url: event.target.value })}
                  />
                </Field>
              </>
            )}
            {toggle('interleaved_thinking', 'Interleaved thinking header')}
            {toggle('prompt_cache_key', 'Prompt cache key')}
            {toggle('stream_usage', 'Streamed usage')}
            {readsAccountKey(draft.backend, 'max_tool_name_bytes') && (
              <Field label="Max tool name bytes">
                <input
                  type="number"
                  min={16}
                  step={1}
                  inputMode="numeric"
                  placeholder="Default"
                  value={draft.max_tool_name_bytes}
                  onChange={(event) => set({ max_tool_name_bytes: event.target.value })}
                />
              </Field>
            )}
          </div>
        </details>
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy}>
            {action.busy ? 'Adding…' : 'Add account'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function RenameAccount({ name, onSaved }: { name: string; onSaved: () => Promise<void> }) {
  const { api } = useConnection();
  const action = useAction();
  const rename = useRenameInOrder();
  const [value, setValue] = useState(name);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!api) return;
      if (value.trim() !== name) {
        await api.mutate('PATCH', `/v1/accounts/${segment(name)}`, {
          name: value.trim(),
        } satisfies Schema['RenameRequest']);
        rename('accounts', name, value.trim());
      }
      await onSaved();
    });
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="form-stack" disabled={action.busy}>
        <Field label="Name">
          <input required value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
        <ErrorNotice error={action.error} />
        <div className="actions">
          <Button type="submit" disabled={action.busy}>
            {action.busy ? 'Saving…' : 'Rename'}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function AccountSignIn({
  account,
  onDone,
}: {
  account: Schema['AccountView'];
  onDone: () => Promise<void>;
}) {
  const { api } = useConnection();
  const action = useAction();
  const [key, setKey] = useState('');
  const [started, setStarted] = useState<Schema['LoginStarted']>();
  const path = `/v1/accounts/${segment(account.name)}/login`;
  if (!isSubscription(account.backend)) {
    const submit = async (event: FormEvent) => {
      event.preventDefault();
      await action.run(async () => {
        if (!api) return;
        await api.mutate('POST', path, { api_key: key.trim() } satisfies Schema['LoginRequest']);
        await onDone();
      });
    };
    return (
      <form onSubmit={(event) => void submit(event)}>
        <fieldset className="form-stack" disabled={action.busy}>
          <Field label="API key" hint="Replaces the stored key.">
            <input
              required
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <ErrorNotice error={action.error} />
          <div className="actions">
            <Button type="submit" disabled={action.busy}>
              {action.busy ? 'Saving…' : 'Save key'}
            </Button>
          </div>
        </fieldset>
      </form>
    );
  }
  // Each start replaces a login still pending, so it waits for a press rather than the dialog.
  const begin = () =>
    void action.run(async () => {
      if (!api) return;
      setStarted(undefined);
      setStarted(await api.mutate<Schema['LoginStarted']>('POST', path));
    });
  if (started)
    return (
      <BrowserLogin
        key={started.login_id}
        started={started}
        path={`${path}/${segment(started.login_id)}`}
        onDone={onDone}
        onRestart={begin}
      />
    );
  return (
    <div className="form-stack">
      <p className="muted small">
        {backendLabel(account.backend)} signs in through the browser.
        {account.authenticated === 'yes' && ' Signing in again replaces the stored sign-in.'}
      </p>
      <ErrorNotice error={action.error} />
      <div className="actions">
        <Button disabled={action.busy} onClick={begin}>
          <LogIn size={16} />
          {action.busy ? 'Starting…' : 'Start sign-in'}
        </Button>
      </div>
    </div>
  );
}
