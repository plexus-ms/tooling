// What a caught exception says, for a RenderError's message.

/** The message of a thrown value, whatever was thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
