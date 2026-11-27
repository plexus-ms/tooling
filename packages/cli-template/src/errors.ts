// What a caught exception says, for a RenderError's message.

/** The message of a thrown value, whatever was thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An error in what the command was given, such as a directory that is missing; it names the path where there is one. */
export class InputError extends Error {
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    if (path !== undefined) this.path = path;
  }
}
