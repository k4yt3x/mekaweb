import { useAction } from '../components/actions';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { LogIn, Pencil, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import { segment, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { ConfirmButton, Empty, ErrorNotice, Loading } from '../components/common';
import { McpServerForm, McpSignIn } from './mcp-server-form';
export function McpPage() {
  const servers = useResource<Schema['McpServersResponse']>('/v1/mcp');
  const { api } = useConnection();
  const runtime = useRuntime();
  const canRead = useCan('mcp:r');
  const canWrite = useCan('mcp:w');
  const canConfigure = useCan('config:w');
  const [selected, setSelected] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Schema['McpServerDetail']>();
  const [signingIn, setSigningIn] = useState<Schema['McpServerDetail']>();
  const [outcome, setOutcome] = useState('');
  const action = useAction();
  const tools = useResource<Schema['McpToolsResponse']>(
    `/v1/mcp/${segment(selected ?? '_')}/tools`,
    undefined,
    Boolean(selected) && canRead,
  );
  return (
    <div className="page">
      <header className="page-heading">
        <div>
          <h1>MCP servers</h1>
        </div>
        <div className="actions">
          <Button variant="secondary" onClick={() => void servers.refetch()}>
            <RefreshCw size={16} />
            Refresh
          </Button>
          <Button
            disabled={!canConfigure}
            title={!canConfigure ? 'Requires config:w' : undefined}
            onClick={() => setAdding(true)}
          >
            <Plus size={16} />
            Add server
          </Button>
        </div>
      </header>
      <ErrorNotice error={servers.error ?? action.error} />
      {outcome && (
        <p className="notice" role="status">
          {outcome}
        </p>
      )}
      {servers.isPending && <Loading />}
      <div className="resource-grid mcp-grid">
        {servers.data?.servers.map((server) => (
          <article className="panel mcp-card" key={server.name}>
            <header className="card-heading">
              <Plug size={20} />
              <h2>{server.name}</h2>
              <span className={`badge ${server.state === 'connected' ? 'success' : ''}`}>
                {server.state}
              </span>
              {/* The MCP revision a connected server speaks, which meka settles as it connects. */}
              {server.protocol_version && (
                <span className="badge" title="MCP protocol version">
                  {server.protocol_version}
                </span>
              )}
            </header>
            <ServerSummary
              server={server}
              onEdit={setEditing}
              onSignIn={setSigningIn}
              onRemoved={() => void runtime.queries.invalidateQueries()}
            >
              <div className="actions wrap">
                <Button
                  variant="secondary"
                  disabled={!canRead || server.state !== 'connected'}
                  title={
                    !canRead
                      ? 'Requires mcp:r'
                      : server.state !== 'connected'
                        ? 'Tools are available once this server connects.'
                        : undefined
                  }
                  onClick={() => setSelected(server.name)}
                >
                  View tools
                </Button>
                <Button
                  variant="ghost"
                  disabled={!canWrite || action.busy || server.state === 'disabled'}
                  title={
                    !canWrite
                      ? 'Requires mcp:w'
                      : server.state === 'disabled'
                        ? 'Enable this server first.'
                        : undefined
                  }
                  onClick={() =>
                    void action.run(async () => {
                      if (!api) return;
                      const result = await api.mutate<Schema['McpReconnectResponse']>(
                        'POST',
                        `/v1/mcp/${segment(server.name)}/reconnect`,
                      );
                      setOutcome(
                        `${result.server}: ${result.state}${result.state === 'failed' ? '. Check the MCP server configuration and logs.' : result.state === 'pending' ? '. A connection attempt is already in progress.' : '.'}`,
                      );
                      await runtime.queries.invalidateQueries();
                    })
                  }
                >
                  Reconnect
                </Button>
              </div>
            </ServerSummary>
          </article>
        ))}
      </div>
      {servers.data?.servers.length === 0 && <Empty title="No MCP servers configured" />}
      {servers.data?.orphaned_credentials?.length ? (
        <section className="panel mcp-leftovers">
          <h2>Leftover credentials</h2>
          <p className="muted small">Stored for servers no longer configured.</p>
          {servers.data.orphaned_credentials.map((name) => (
            <div className="setting-row" key={name}>
              <strong>{name}</strong>
              <ConfirmButton
                disabled={!canConfigure}
                title="Remove credentials"
                description={`Remove the credentials stored for “${name}”?`}
                onConfirm={async () => {
                  await api?.mutate('DELETE', `/v1/mcp/${segment(name)}`);
                  await runtime.queries.invalidateQueries();
                }}
              >
                <Trash2 size={14} />
                Remove
              </ConfirmButton>
            </div>
          ))}
        </section>
      ) : null}
      <Dialog open={adding} onOpenChange={setAdding} title="Add MCP server" wide>
        {adding && (
          <McpServerForm
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              setAdding(false);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        title={`Edit ${editing?.name ?? 'server'}`}
        description="A change to how it connects restarts it."
        wide
      >
        {editing && (
          <McpServerForm
            initial={editing}
            onSaved={async () => {
              await runtime.queries.invalidateQueries();
              setEditing(undefined);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={signingIn !== undefined}
        onOpenChange={(open) => {
          if (!open) setSigningIn(undefined);
        }}
        title={`Sign in to ${signingIn?.name ?? 'server'}`}
      >
        {signingIn && (
          <McpSignIn
            detail={signingIn}
            onDone={async () => {
              await runtime.queries.invalidateQueries();
              setSigningIn(undefined);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        title={`${selected ?? 'Server'} tools`}
        wide
      >
        <ErrorNotice error={tools.error} />
        {tools.isPending ? (
          <Loading />
        ) : (
          tools.data?.tools.map((tool) => (
            <article className="tool-catalog-entry" key={tool.raw_name}>
              <h3>
                {tool.raw_name} <span className="badge">{tool.required_permission}</span>
                {!tool.allowed && <span className="badge">Filtered out</span>}
                {/* How an allowed tool reaches the agent, unless declared from the first request. */}
                {tool.allowed && tool.loading === 'deferred' && (
                  <span className="badge">Deferred</span>
                )}
                {tool.allowed && tool.loading === 'hidden' && <span className="badge">Hidden</span>}
              </h3>
              <p>{tool.description}</p>
              <details>
                <summary>Permission details</summary>
                <p>Source: {tool.permission_source}.</p>
                {tool.read_only_hint_declined && (
                  <p>The server’s read-only hint was not trusted.</p>
                )}
              </details>
            </article>
          ))
        )}
        {tools.data?.tools.length === 0 && <Empty title="No tools advertised" />}
      </Dialog>
    </div>
  );
}

/** What `config.toml` says of a server, why it failed, and what can be done to its entry. */
function ServerSummary({
  server,
  onEdit,
  onSignIn,
  onRemoved,
  children,
}: {
  server: Schema['McpServerStateView'];
  children: ReactNode;
  onEdit: (detail: Schema['McpServerDetail']) => void;
  onSignIn: (detail: Schema['McpServerDetail']) => void;
  onRemoved: () => void;
}) {
  const { api } = useConnection();
  const canRead = useCan('config:r');
  const canWrite = useCan('config:w');
  // Set once the server is removed, so its entry is not read again before its card goes.
  const [removed, setRemoved] = useState(false);
  const detail = useResource<Schema['McpServerStatus']>(
    `/v1/mcp/${segment(server.name)}`,
    undefined,
    canRead && !removed,
  );
  // A server that changed state may have failed, or recovered, since its entry was read.
  const seen = useRef(server.state);
  const refetch = detail.refetch;
  useEffect(() => {
    if (seen.current === server.state) return;
    seen.current = server.state;
    if (canRead && !removed) void refetch();
  }, [server.state, canRead, removed, refetch]);
  const data = detail.data;
  return (
    <>
      {data && (
        <p className="muted small mcp-summary">
          {data.transport === 'http' ? data.url : [data.command, ...(data.args ?? [])].join(' ')}
        </p>
      )}
      {data?.error && <p className="mcp-error small">{data.error}</p>}
      {children}
      {canWrite && data && (
        <div className="actions wrap">
          <Button variant="ghost" onClick={() => onEdit(data)}>
            <Pencil size={14} />
            Edit
          </Button>
          {data.transport === 'http' && (
            <Button variant="ghost" onClick={() => onSignIn(data)}>
              <LogIn size={14} />
              Sign in
            </Button>
          )}
          <ConfirmButton
            title="Remove MCP server"
            description={`Remove “${server.name}” and its stored credentials? Its tools leave every session.`}
            onConfirm={async () => {
              await api?.mutate('DELETE', `/v1/mcp/${segment(server.name)}`);
              flushSync(() => setRemoved(true));
              onRemoved();
            }}
          >
            <Trash2 size={14} />
            Remove
          </ConfirmButton>
        </div>
      )}
    </>
  );
}
