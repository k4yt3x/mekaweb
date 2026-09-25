import { afterEach, expect, it, vi } from 'vitest';
import { CompletionSound } from './sound';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  const context = {
    state: 'suspended',
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {
      context.state = 'running';
    }),
    close: vi.fn(async () => {
      context.state = 'closed';
    }),
    createGain: () => ({
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createOscillator: () => {
      const oscillator = {
        type: '',
        frequency: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: () => {},
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(oscillator);
      return oscillator;
    },
  };
  const construct = vi.fn();
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        construct();
        return context;
      }
    },
  );
  return { sound: new CompletionSound(), context, oscillators, construct };
}
it('creates audio only after interaction and coalesces nearby completion sounds', () => {
  const f = fixture();
  expect(f.sound.play()).toBe(false);
  expect(f.construct).not.toHaveBeenCalled();
  f.sound.arm();
  expect(f.sound.play()).toBe(true);
  expect(f.oscillators).toHaveLength(2);
  f.sound.play();
  expect(f.oscillators).toHaveLength(2);
  f.context.currentTime = 1;
  f.sound.play();
  expect(f.oscillators).toHaveLength(4);
  f.sound.stop();
  expect(f.context.close).toHaveBeenCalledOnce();
});
it('lets explicit previews play immediately and never queues audio for a blocked context', async () => {
  const f = fixture();
  expect(await f.sound.preview()).toBe(true);
  expect(await f.sound.preview()).toBe(true);
  expect(f.oscillators).toHaveLength(4);
  f.context.state = 'suspended';
  expect(f.sound.play()).toBe(false);
  expect(f.oscillators).toHaveLength(4);
  f.sound.stop();
});
it('handles missing audio support without throwing', async () => {
  vi.stubGlobal('AudioContext', undefined);
  const sound = new CompletionSound();
  expect(await sound.preview()).toBe(false);
  sound.stop();
});

it('replaces an unfinished preview instead of stacking its volume', async () => {
  const f = fixture();
  await f.sound.preview();
  const previous = f.oscillators.slice();
  await f.sound.preview();
  for (const oscillator of previous) expect(oscillator.stop).toHaveBeenCalledTimes(2);
  f.sound.stop();
  for (const oscillator of f.oscillators.slice(2)) expect(oscillator.stop).toHaveBeenCalledTimes(2);
});
