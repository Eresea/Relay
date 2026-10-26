import {
  batch,
  computed as preactComputed,
  effect as preactEffect,
  signal as preactSignal,
  untracked,
  type ReadonlySignal,
} from '@preact/signals-react';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useState } from 'react';

/**
 * Relay's state primitive: Preact signals behind Angular's call syntax.
 *
 * Services and controllers read a signal by calling it (`count()`) and write
 * with `set` / `update`, exactly as they did under Angular, so state logic
 * moved across without rewriting. A component that reads signals while
 * rendering calls `useSignals()` once, first thing; every read after that
 * subscribes the component, and only it re-renders when they change.
 */
export interface Signal<T> {
  (): T;
  /** The Preact signal underneath, for `peek()` and `subscribe()`. */
  readonly source: ReadonlySignal<T>;
}

export interface WritableSignal<T> extends Signal<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
  asReadonly(): Signal<T>;
}

function readable<T>(source: ReadonlySignal<T>): Signal<T> {
  const read = () => source.value;
  return Object.defineProperty(read, 'source', { value: source }) as Signal<T>;
}

export function signal<T>(initial: T): WritableSignal<T> {
  const source = preactSignal(initial);
  return Object.assign(readable(source), {
    set(value: T) {
      source.value = value;
    },
    // Reads with peek(): like Angular, an update never subscribes its caller.
    update(fn: (value: T) => T) {
      source.value = fn(source.peek());
    },
    asReadonly: () => readable(source),
  });
}

export function computed<T>(fn: () => T): Signal<T> {
  return readable(preactComputed(fn));
}

/**
 * Runs `fn` now and again whenever a signal it read changes. `fn` may return a
 * cleanup, run before the next run and on dispose. Returns the disposer.
 */
export function effect(fn: () => void | (() => void)): () => void {
  return preactEffect(fn);
}

export { batch, untracked, useSignals };

/** A signal owned by one component instance. */
export function useLocalSignal<T>(initial: T | (() => T)): WritableSignal<T> {
  const [state] = useState(() =>
    signal(typeof initial === 'function' ? (initial as () => T)() : initial),
  );
  return state;
}

/** An `effect` that lives as long as the component that declares it. */
export function useSignalEffect(fn: () => void | (() => void)): void {
  // The effect re-runs on its own signals, not on React props: deliberately once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => effect(fn), []);
}

/**
 * What a screen's state object releases when its screen unmounts: event
 * listeners, effects, timers. Angular's DestroyRef, kept by name so ported
 * code reads the same: `this.destroyRef.onDestroy(unlisten)`, and
 * `this.destroyRef.effect(...)` for an effect that should stop with the screen.
 */
export class DestroyRef {
  destroyed = false;
  private readonly callbacks: (() => void)[] = [];

  onDestroy(callback: () => void): void {
    if (this.destroyed) callback();
    else this.callbacks.push(callback);
  }

  effect(fn: () => void | (() => void)): void {
    this.onDestroy(effect(fn));
  }

  destroy(): void {
    this.destroyed = true;
    for (const callback of this.callbacks.splice(0)) callback();
  }
}

/**
 * A screen's state object, created once per mount like an Angular component
 * instance. Its optional `start()` runs after mount and returns a disposer;
 * its optional `destroyRef` is destroyed on unmount.
 */
interface Lifecycle {
  start?: () => () => void;
  destroyRef?: DestroyRef;
}

export function useController<T extends object>(create: () => T): T {
  const [controller] = useState(create);
  useEffect(() => {
    const { start, destroyRef } = controller as Lifecycle;
    const stop = start?.call(controller);
    return () => {
      stop?.();
      destroyRef?.destroy();
    };
  }, [controller]);
  return controller;
}
