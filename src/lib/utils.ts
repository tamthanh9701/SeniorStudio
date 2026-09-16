import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, letting later Tailwind utilities win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Runs `mapper` over `items` with at most `limit` calls in flight, preserving the
 * input order of the results. Needed wherever a loop would otherwise serialise
 * per-item work against a remote service (object downloads, provider lookups).
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let active = 0;
  return new Promise((resolve, reject) => {
    const schedule = () => {
      if (nextIndex >= items.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < size && nextIndex < items.length) {
        const index = nextIndex++;
        active += 1;
        mapper(items[index], index).then((result) => {
          results[index] = result;
          active -= 1;
          schedule();
        }, reject);
      }
    };
    schedule();
  });
}
