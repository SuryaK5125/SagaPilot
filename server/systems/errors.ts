/**
 * Error raised by a simulated business system. It mirrors what a real HTTP API
 * would return (status code + machine-readable code), so the agent sees the
 * same kind of failure it would see from a real SaaS backend.
 */
export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly retryable: boolean = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServiceError';
  }

  toJSON() {
    return {
      code: this.code,
      http_status: this.httpStatus,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
