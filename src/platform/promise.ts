export interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function withResolvers<T>(): PromiseResolvers<T> {
  return (
    Promise as PromiseConstructor & {
      withResolvers<T>(): PromiseResolvers<T>;
    }
  ).withResolvers<T>();
}
