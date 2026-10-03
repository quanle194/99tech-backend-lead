// Expected business failures. The error handler maps them to `{ error: code, ...details }`.
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
