import { afterEach, expect, it, vi } from 'vitest';
import { CompletionSound } from './sound';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  const nodes: { disconnect: ReturnType<typeof vi.fn> }[] = [];
  const node = <T extends object>(extra: T) => {
    const created = { connect: vi.fn((target: unknown) => target), disconnect: vi.fn(), ...extra };
    nodes.push(created);
    return created;
  };
  const source = <T extends object>(extra: T) =>
    node({ onended: () => {}, start: vi.fn(), stop: vi.fn(), ...extra });
  const oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  const timers: { onended: () => void }[] = [];
  const context = {
    state: 'suspended',
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    resume: vi.fn(async () => {
      context.state = 'running';
    }),
    close: vi.fn(async () => {
      context.state = 'closed';
    }),
    createGain: () => node({ gain: param() }),
    createStereoPanner: () => node({ pan: param() }),
    createBiquadFilter: () => node({ type: '', frequency: param(), Q: param() }),
    createDelay: () => node({ delayTime: param() }),
    createChannelMerger: () => node({}),
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => source({ buffer: null }),
    createConstantSource: () => {
      const timer = source({ offset: param() });
      timers.push(timer);
      return timer;
    },
    createOscillator: () => {
      const oscillator = source({ type: '', frequency: param() });
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
  return { sound: new CompletionSound(), context, oscillators, timers, nodes, construct };
}
it('creates audio only after interaction and coalesces nearby completion sounds', () => {
  const f = fixture();
  expect(f.sound.play()).toBe(false);
  expect(f.construct).not.toHaveBeenCalled();
  f.sound.arm();
  expect(f.sound.play()).toBe(true);
  expect(f.oscillators).toHaveLength(6);
  f.sound.play();
  expect(f.oscillators).toHaveLength(6);
  f.context.currentTime = 1;
  f.sound.play();
  expect(f.oscillators).toHaveLength(12);
  f.sound.stop();
  expect(f.context.close).toHaveBeenCalledOnce();
});
it('lets explicit previews play immediately and never queues audio for a blocked context', async () => {
  const f = fixture();
  expect(await f.sound.preview()).toBe(true);
  expect(await f.sound.preview()).toBe(true);
  expect(f.oscillators).toHaveLength(12);
  f.context.state = 'suspended';
  expect(f.sound.play()).toBe(false);
  expect(f.oscillators).toHaveLength(12);
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
  for (const oscillator of f.oscillators.slice(6)) expect(oscillator.stop).toHaveBeenCalledTimes(2);
});

it('releases the whole graph, including the echo loop, once the tail has passed', () => {
  const f = fixture();
  f.sound.arm();
  expect(f.sound.play()).toBe(true);
  expect(f.nodes.some((node) => node.disconnect.mock.calls.length)).toBe(false);
  f.timers[0]?.onended();
  for (const node of f.nodes) expect(node.disconnect).toHaveBeenCalledOnce();
  f.sound.stop();
  for (const node of f.nodes) expect(node.disconnect).toHaveBeenCalledOnce();
});
