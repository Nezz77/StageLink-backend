import assert from 'node:assert/strict';

const actualDate = Date;

export async function serverClock<T>(offsetMs: number, work: () => Promise<T>): Promise<T> {
  assert.equal(globalThis.Date, actualDate);
  const now = () => actualDate.now() + offsetMs;
  globalThis.Date = new Proxy(actualDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [now()], newTarget);
    },
    apply() { return new actualDate(now()).toString(); },
    get(target, key, receiver) { return key === 'now' ? now : Reflect.get(target, key, receiver); },
  });
  try {
    return await work();
  } finally {
    globalThis.Date = actualDate;
  }
}
