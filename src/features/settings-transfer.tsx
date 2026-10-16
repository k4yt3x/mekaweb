import { useState } from 'react';
import { Import, Share as Export } from 'lucide-react';
import { useRuntime, useSettings } from '../connections/context';
import {
  TRANSFER_SIZE_LIMIT,
  exportSettings,
  planImport,
  readTransfer,
  type ImportPlan,
  type Transfer,
} from '../connections/transfer';
import { CONNECTION_LIMIT } from '../connections/storage';
import { download } from '../api/client';
import { useAction } from '../components/actions';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { SwitchField } from '../components/ui/switch';
import { ErrorNotice } from '../components/common';

const host = (endpoint: string) => new URL(endpoint).host;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function SettingsTransferPanel() {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState('');
  return (
    <section className="panel">
      <h2>Import and export</h2>
      <p className="muted">
        Move your connections and preferences to another browser with a settings file.
      </p>
      <div className="actions wrap">
        <Button variant="secondary" onClick={() => setExporting(true)}>
          <Export size={16} />
          Export settings
        </Button>
        <ImportSettingsButton variant="secondary" onImported={setResult} />
      </div>
      {result && (
        <p className="muted small" role="status">
          {result}
        </p>
      )}
      <ExportDialog open={exporting} onOpenChange={setExporting} />
    </section>
  );
}

function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { storage } = useRuntime();
  const [tokens, setTokens] = useState(false);
  // Every close resets the choice, so tokens are never included by default.
  function close() {
    setTokens(false);
    onOpenChange(false);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) onOpenChange(true);
        else close();
      }}
      title="Export settings"
      description="Saves your connections, their order, and your preferences to a file. Window layout and browser notification permission stay with this browser."
    >
      <SwitchField label="Include API tokens" checked={tokens} onCheckedChange={setTokens} />
      {tokens && (
        <p className="notice warning">
          Anyone with this file can use these tokens. Keep it private, and delete it once imported.
        </p>
      )}
      <div className="actions">
        <Button variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            const date = new Date().toISOString().slice(0, 10);
            download(
              new Blob([exportSettings(storage, tokens)], { type: 'application/json' }),
              `mekaweb-settings-${date}.json`,
            );
            close();
          }}
        >
          Export
        </Button>
      </div>
    </Dialog>
  );
}

/** Picks a settings file, then confirms what it adds before anything is saved. */
export function ImportSettingsButton({
  variant = 'ghost',
  onImported,
}: {
  variant?: 'secondary' | 'ghost';
  onImported?: (summary: string) => void;
}) {
  const settings = useSettings();
  const action = useAction();
  const [pending, setPending] = useState<{ name: string; transfer: Transfer; plan: ImportPlan }>();
  return (
    <>
      <label className={`button button-${variant}`}>
        <Import size={16} />
        Import settings
        <input
          className="sr-only"
          type="file"
          accept="application/json,.json"
          disabled={action.busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file)
              void action.run(async () => {
                if (file.size > TRANSFER_SIZE_LIMIT)
                  throw new Error('This file is too large to be a mekaweb settings export.');
                const transfer = readTransfer(await file.text());
                setPending({
                  name: file.name,
                  transfer,
                  plan: planImport(settings.connections, transfer),
                });
              });
          }}
        />
      </label>
      {Boolean(action.error) && (
        <div className="transfer-error">
          <ErrorNotice error={action.error} />
        </div>
      )}
      {pending && (
        <ImportDialog
          {...pending}
          onClose={() => setPending(undefined)}
          onImported={(summary) => {
            setPending(undefined);
            onImported?.(summary);
          }}
        />
      )}
    </>
  );
}

function ImportDialog({
  name,
  transfer,
  plan,
  onClose,
  onImported,
}: {
  name: string;
  transfer: Transfer;
  plan: ImportPlan;
  onClose: () => void;
  onImported: (summary: string) => void;
}) {
  const { storage } = useRuntime();
  const hasPreferences = Object.keys(transfer.preferences ?? {}).length > 0;
  const [preferences, setPreferences] = useState(hasPreferences);
  const exported = transfer.exported ? new Date(transfer.exported) : undefined;
  const nothing = plan.add.length === 0 && !preferences;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Import settings"
      description={`From ${name}${
        exported && Number.isFinite(exported.getTime())
          ? `, exported ${exported.toLocaleString()}`
          : ''
      }.`}
    >
      {plan.add.length > 0 ? (
        <ul className="import-list" aria-label="Connections to add">
          {plan.add.map((connection, index) => (
            <li key={index}>
              <span>
                <strong>{connection.name.trim() || host(connection.endpoint)}</strong>
                <small className="muted">{connection.endpoint}</small>
              </span>
              {connection.suspended && <span className="tag">Suspended</span>}
              <span className="tag">{connection.token ? 'Token' : 'No token'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No new connections to add.</p>
      )}
      {plan.existing.length > 0 && (
        <p className="muted small">
          Already saved here, so skipped:{' '}
          {plan.existing.map((c) => c.name.trim() || host(c.endpoint)).join(', ')}.
        </p>
      )}
      {plan.excess.length > 0 && (
        <p className="notice warning">
          {plural(plan.excess.length, 'connection')} would pass the limit of {CONNECTION_LIMIT} and
          will be skipped.
        </p>
      )}
      {plan.add.some((connection) => !connection.token) && (
        <p className="muted small">Connections without a token ask for one when you connect.</p>
      )}
      {hasPreferences && (
        <SwitchField
          label="Replace this browser’s preferences with the file’s"
          checked={preferences}
          onCheckedChange={setPreferences}
        />
      )}
      <div className="actions">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={nothing}
          onClick={() => {
            const added = storage.importSettings(
              plan.add,
              preferences ? transfer.preferences : undefined,
            );
            onImported(
              [
                added.length ? `Added ${plural(added.length, 'connection')}` : '',
                preferences ? 'applied preferences' : '',
              ]
                .filter(Boolean)
                .join(' and ')
                .replace(/^./, (first) => first.toUpperCase()) + '.',
            );
          }}
        >
          Import
        </Button>
      </div>
    </Dialog>
  );
}
