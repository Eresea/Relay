import { TauriBridge } from '@/core/tauri';
import { provide } from '@/lib/inject';

/**
 * A TauriBridge for tests: the real one, whose calls are no-ops outside Tauri,
 * with the methods a test cares about replaced. Provided to every inject().
 */
export function provideBridge<T extends Partial<Record<keyof TauriBridge, unknown>>>(
  overrides: T,
): TauriBridge & T {
  const bridge = Object.assign(new TauriBridge(), overrides);
  provide(TauriBridge, bridge);
  return bridge;
}
