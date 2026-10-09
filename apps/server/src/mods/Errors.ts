import { Schema } from "effect";

export class ModHostError extends Schema.TaggedErrorClass<ModHostError>()("ModHostError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}
