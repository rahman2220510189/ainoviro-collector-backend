/**
 * Application error with a stable machine-readable code.
 * Every API error response has the shape: { error: { code, message, details } }.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: unknown;
  };
}

/** Build the standard error response body. */
export function errorBody(code: string, message: string, details: unknown = null): ErrorBody {
  return { error: { code, message, details } };
}