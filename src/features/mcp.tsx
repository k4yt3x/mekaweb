import { useAction } from '../components/actions';
import { useState } from 'react';
import { Plug, RefreshCw } from 'lucide-react';
import { useCan, useConnection, useResource, useRuntime } from '../connections/context';
import { segment, type Schema } from '../api/client';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Empty, ErrorNotice, Loading } from '../components/common';
export function McpPage() {
  const servers = useResource<Schema['McpServerStateView'][]>('/v1/mcp');
  const { api } = useConnection();
  const runtime = useRuntime();
  const canRead = useCan('mcp:r');
  const canWrite = useCan('mcp:w');
  const [selected, setSelected] = useState<string>();
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
        <Button variant="secondary" onClick={() => void servers.refetch()}>
          <RefreshCw size={16} />
          Refresh
        </Button>
      </header>
      <ErrorNotice error={servers.error ?? action.error} />
      {outcome && (
        <p className="notice" role="status">
          {outcome}
        </p>
      )}
      {servers.isPending && <Loading />}
      <div className="resource-grid mcp-grid">
        {servers.data?.map((server) => (
          <article className="panel mcp-card" key={server.name}>
            <header className="card-heading">
              <Plug size={20} />
              <h2>{server.name}</h2>
              <span className={`badge ${server.state === 'connected' ? 'success' : ''}`}>
                {server.state}
              </span>
            </header>
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
                      ? 'Enable this server in meka configuration first.'
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
          </article>
        ))}
      </div>
      {servers.data?.length === 0 && <Empty title="No MCP servers configured" />}
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
