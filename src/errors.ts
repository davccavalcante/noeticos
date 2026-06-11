/**
 * Error type for the NoeticOS runtime.
 *
 * Every failure raised by the engine carries a stable machine-readable `code`
 * so callers can branch on the cause without parsing the human-readable message.
 */
export class NoeticosError extends Error {
  /** Stable machine-readable error code, part of the public contract. */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'NoeticosError';
    this.code = code;
  }

  /** Builds an error with code `ERR_INVALID_INPUT` for rejected caller input. */
  static invalid(message: string): NoeticosError {
    return new NoeticosError(message, 'ERR_INVALID_INPUT');
  }
}
