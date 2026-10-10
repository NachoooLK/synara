// Ordered, atomic local pins. Remote services never own this state.
import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { ModPullRequestIdentity, ModPullRequestSourceRef } from "@synara/contracts";
import { writeFileStringAtomically } from "../atomicWrite";

const Pin = Schema.Struct({ source: ModPullRequestSourceRef, ...ModPullRequestIdentity.fields });
type Pin = typeof Pin.Type;
const key = (source: ModPullRequestSourceRef, identity: ModPullRequestIdentity) =>
  JSON.stringify([source.modId, source.sourceId, identity.repository, identity.itemId]);
export class ModPullRequestPins {
  private pins = new Map<string, Pin>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    try {
      const pins = Schema.decodeUnknownSync(Schema.Array(Pin))(
        JSON.parse(await readFile(this.file, "utf8")),
      );
      this.pins = new Map(pins.map((pin) => [key(pin.source, pin), pin]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  isPinned(source: ModPullRequestSourceRef, identity: ModPullRequestIdentity): boolean {
    return this.pins.has(key(source, identity));
  }
  setPinned(
    source: ModPullRequestSourceRef,
    identity: ModPullRequestIdentity,
    value: boolean,
  ): Promise<void> {
    const pin = Schema.decodeUnknownSync(Pin)({ source, ...identity });
    return this.change((next) => {
      if (value) next.set(key(source, identity), pin);
      else next.delete(key(source, identity));
    });
  }
  removeMod(modId: string): Promise<void> {
    return this.change((next) => {
      for (const [id, pin] of next) if (pin.source.modId === modId) next.delete(id);
    });
  }
  private change(update: (next: Map<string, Pin>) => void): Promise<void> {
    const result = this.writes
      .catch(() => undefined)
      .then(async () => {
        const next = new Map(this.pins);
        update(next);
        await Effect.runPromise(
          writeFileStringAtomically({
            filePath: this.file,
            contents: JSON.stringify([...next.values()]),
          }),
        );
        this.pins = next;
      });
    this.writes = result;
    return result;
  }
  async flush(): Promise<void> {
    await this.writes;
  }
  async retainMods(present: ReadonlySet<string>): Promise<void> {
    if ([...this.pins.values()].some((pin) => !present.has(pin.source.modId)))
      await this.change((next) => {
        for (const [id, pin] of next) if (!present.has(pin.source.modId)) next.delete(id);
      });
  }
}
