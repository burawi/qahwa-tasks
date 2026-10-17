export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

export function assertDomain(condition: unknown, message: string, code: string, statusCode = 400): asserts condition {
  if (!condition) throw new DomainError(message, code, statusCode);
}
