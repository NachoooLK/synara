// Share three read slots across Code review sources, leaving a mod RPC slot for actions.
let active = 0;
const waiting: Array<() => void> = [];
export async function scheduleModRead<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (active >= 3) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = waiting.indexOf(ready);
        if (index !== -1) waiting.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      waiting.push(ready);
      signal.addEventListener("abort", abort, { once: true });
    });
  } else active++;
  try {
    signal.throwIfAborted();
    return await read();
  } finally {
    // Transfer the slot directly, so a new read cannot overtake a queued one.
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
