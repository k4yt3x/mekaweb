import { expect, it } from 'vitest';
import { BrowserStorage, CONNECTION_LIMIT } from './storage';
import { exportSettings, planImport, readTransfer } from './transfer';

function fixture() {
  const storage = new BrowserStorage(undefined, undefined);
  storage.saveConnection('Home', 'https://home.example', 'home-token', true);
  const away = storage.saveConnection('Away', 'https://away.example', 'away-token', false);
  storage.suspend(away.id, true);
  storage.theme('dark');
  return storage;
}

it('exports connections in order, with tokens only when asked', () => {
  const storage = fixture();
  const without = JSON.parse(exportSettings(storage, false)) as Record<string, unknown>;
  expect(without).toMatchObject({
    format: 'mekaweb-settings',
    version: 1,
    preferences: { theme: 'dark', conversationFontSize: 14 },
    connections: [
      { name: 'Home', endpoint: 'https://home.example/', remember: true },
      { name: 'Away', endpoint: 'https://away.example/', remember: false, suspended: true },
    ],
  });
  expect(JSON.stringify(without)).not.toContain('token"');
  expect(without.preferences).not.toHaveProperty('layout');
  expect(without.preferences).not.toHaveProperty('turnNotifications');
  const transfer = readTransfer(exportSettings(storage, true));
  expect(transfer.connections.map((c) => c.token)).toEqual(['home-token', 'away-token']);
});

it('reads its own exports back and refuses anything else', () => {
  const transfer = readTransfer(exportSettings(fixture(), false));
  expect(transfer.connections).toEqual([
    { name: 'Home', endpoint: 'https://home.example/', remember: true },
    { name: 'Away', endpoint: 'https://away.example/', remember: false, suspended: true },
  ]);
  expect(transfer.preferences).toMatchObject({ theme: 'dark' });
  const file = (value: object) =>
    JSON.stringify({ format: 'mekaweb-settings', version: 1, ...value });
  expect(readTransfer(file({ connections: [{ endpoint: 'https://meka.example' }] }))).toEqual({
    connections: [{ name: '', endpoint: 'https://meka.example/', remember: true }],
  });
  expect(() => readTransfer('not json')).toThrow('not a mekaweb settings export');
  expect(() => readTransfer('{"format":"other","version":1}')).toThrow('not a mekaweb');
  expect(() => readTransfer(file({ version: 2 }))).toThrow('newer mekaweb');
  expect(() => readTransfer(file({ connections: {} }))).toThrow('no valid connection list');
  expect(() =>
    readTransfer(file({ connections: [{ endpoint: 'https://a.example' }, { name: 'x' }] })),
  ).toThrow('Connection 2');
  expect(() =>
    readTransfer(file({ connections: [{ endpoint: 'https://a.example', token: 5 }] })),
  ).toThrow('Connection 1');
  expect(() => readTransfer(file({ connections: [{ endpoint: 'meka.example' }] }))).toThrow(
    'Connection 1',
  );
  // Under the limit as written, past it once its spaces are encoded.
  const long = `https://meka.example/${'x y'.repeat(1300)}`;
  expect(() => readTransfer(file({ connections: [{ endpoint: long }] }))).toThrow('Connection 1');
  expect(
    readTransfer(file({ connections: [{ endpoint: 'https://a.example', token: '  ' }] }))
      .connections,
  ).toEqual([{ name: '', endpoint: 'https://a.example/', remember: true }]);
});

it('skips connections already saved or repeated, and stops at the limit', () => {
  const storage = fixture();
  const saved = storage.getSnapshot().connections;
  const plan = planImport(saved, {
    connections: [
      { name: 'Home', endpoint: 'https://home.example/', remember: true },
      { name: 'Home', endpoint: 'https://other.example/', remember: true },
      { name: '', endpoint: 'https://new.example/', remember: true },
      { name: 'new.example', endpoint: 'https://new.example/', remember: true },
    ],
  });
  expect(plan.add.map((c) => c.endpoint)).toEqual([
    'https://other.example/',
    'https://new.example/',
  ]);
  expect(plan.existing).toHaveLength(2);
  const many = Array.from({ length: CONNECTION_LIMIT }, (_, index) => ({
    name: `n${index}`,
    endpoint: 'https://many.example/',
    remember: true,
  }));
  const full = planImport(saved, { connections: many });
  expect(full.add).toHaveLength(CONNECTION_LIMIT - saved.length);
  expect(full.excess).toHaveLength(saved.length);
});
