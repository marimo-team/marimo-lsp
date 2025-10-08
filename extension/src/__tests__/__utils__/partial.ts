export function partialService<T>(service: Partial<T>): T {
  return new Proxy(service, {
    get(target, prop) {
      if (prop in target) {
        return target[prop as keyof T];
      }
      throw new Error(`Property ${String(prop)} has not been implemented`);
    },
  }) as T;
}
