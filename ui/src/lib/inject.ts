/**
 * One instance per service class, created on first use: what Angular's
 * root-provided services were. Services keep asking for each other with
 * `inject(TauriBridge)`; components may call it anywhere, render included,
 * since it is a lookup and returns the same object every time.
 */
type ServiceClass<T> = new () => T;

const instances = new Map<ServiceClass<unknown>, unknown>();

export function inject<T>(service: ServiceClass<T>): T {
  let instance = instances.get(service) as T | undefined;
  if (instance === undefined) {
    instance = new service();
    instances.set(service, instance);
  }
  return instance;
}

/** Tests: use `instance` wherever `service` is injected from now on. */
export function provide<T>(service: ServiceClass<T>, instance: T): void {
  instances.set(service, instance);
}

/** Tests: forget every instance, so the next inject builds fresh ones. */
export function resetInjector(): void {
  instances.clear();
}
