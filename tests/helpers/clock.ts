import { runAtTime } from "../../src/server/dal/clock";

/** Runs `fn` with the engine clock fixed at `date`. */
export function atTime<T>(date: Date, fn: () => Promise<T>): Promise<T> {
  return runAtTime(date, fn);
}
