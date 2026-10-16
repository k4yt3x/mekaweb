import { normalizeEndpoint } from '../api/client';
import {
  CONNECTION_LIMIT,
  PORTABLE_PREFERENCES,
  type BrowserStorage,
  type Connection,
  type ImportedConnection,
} from './storage';

const FORMAT = 'mekaweb-settings';
const VERSION = 1;
export const TRANSFER_SIZE_LIMIT = 1024 * 1024;

export interface Transfer {
  exported?: string;
  connections: ImportedConnection[];
  preferences?: Readonly<Record<string, unknown>>;
}
export interface ImportPlan {
  add: ImportedConnection[];
  /** Already saved here under the same name and endpoint, or repeated in the file. */
  existing: ImportedConnection[];
  /** Past the connection limit. */
  excess: ImportedConnection[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length < 4096;

export function exportSettings(storage: BrowserStorage, includeTokens: boolean): string {
  const { connections } = storage.getSnapshot();
  const file = {
    format: FORMAT,
    version: VERSION,
    exported: new Date().toISOString(),
    preferences: storage.preferences(),
    connections: connections.map((connection) => {
      const token = includeTokens ? storage.token(connection) : undefined;
      return {
        name: connection.name,
        endpoint: connection.endpoint,
        remember: connection.remember,
        ...(connection.suspended ? { suspended: true } : {}),
        ...(token ? { token } : {}),
      };
    }),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

/** Reads an export, refusing the whole file if any connection in it is malformed. */
export function readTransfer(source: string): Transfer {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('This file is not a mekaweb settings export.');
  }
  if (!object(value) || value.format !== FORMAT)
    throw new Error('This file is not a mekaweb settings export.');
  if (value.version !== VERSION)
    throw new Error(
      typeof value.version === 'number' && value.version > VERSION
        ? 'This export comes from a newer mekaweb. Update mekaweb to import it.'
        : 'This settings export has an unsupported version.',
    );
  const list = value.connections ?? [];
  if (!Array.isArray(list)) throw new Error('This settings export has no valid connection list.');
  const connections = list.map((item: unknown, index): ImportedConnection => {
    let endpoint: string | undefined;
    try {
      endpoint = object(item) && text(item.endpoint) ? normalizeEndpoint(item.endpoint) : undefined;
    } catch {
      // Reported below with the connection's position.
    }
    if (
      !object(item) ||
      !endpoint ||
      // Storage drops longer values, which would strand the connection's token.
      endpoint.length >= 4096 ||
      (item.name !== undefined && typeof item.name !== 'string') ||
      (typeof item.name === 'string' && item.name.length >= 4096) ||
      (item.remember !== undefined && typeof item.remember !== 'boolean') ||
      (item.suspended !== undefined && typeof item.suspended !== 'boolean') ||
      (item.token !== undefined && !text(item.token))
    )
      throw new Error(`Connection ${index + 1} in this settings export is invalid.`);
    return {
      name: typeof item.name === 'string' ? item.name : '',
      endpoint,
      remember: item.remember !== false,
      ...(item.suspended === true ? { suspended: true } : {}),
      ...(typeof item.token === 'string' && item.token.trim() ? { token: item.token.trim() } : {}),
    };
  });
  const preferences = object(value.preferences) ? value.preferences : undefined;
  return {
    ...(typeof value.exported === 'string' ? { exported: value.exported } : {}),
    connections,
    ...(preferences
      ? {
          preferences: Object.fromEntries(
            PORTABLE_PREFERENCES.filter((key) => key in preferences).map((key) => [
              key,
              preferences[key],
            ]),
          ),
        }
      : {}),
  };
}

/** Splits an export's connections into new ones, ones already saved, and ones past the limit. */
export function planImport(saved: readonly Connection[], transfer: Transfer): ImportPlan {
  const key = (name: string, endpoint: string) =>
    JSON.stringify([name.trim() || new URL(endpoint).host, endpoint]);
  const known = new Set(saved.map((connection) => key(connection.name, connection.endpoint)));
  const plan: ImportPlan = { add: [], existing: [], excess: [] };
  for (const connection of transfer.connections) {
    const identity = key(connection.name, connection.endpoint);
    if (known.has(identity)) plan.existing.push(connection);
    else if (saved.length + plan.add.length >= CONNECTION_LIMIT) plan.excess.push(connection);
    else {
      known.add(identity);
      plan.add.push(connection);
    }
  }
  return plan;
}
