export class HubError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message)
    this.name = new.target.name
  }
}

export class ValidationError extends HubError {
  constructor(message: string) { super(message, 400, 'validation_failed') }
}
export class ForbiddenError extends HubError {
  constructor(message: string) { super(message, 403, 'forbidden') }
}
export class NotFoundError extends HubError {
  constructor(message: string) { super(message, 404, 'not_found') }
}
export class ConflictError extends HubError {
  /** `current` is echoed to the client so a losing writer can resync without a second round trip. */
  constructor(message: string, readonly current?: unknown) { super(message, 409, 'conflict') }
}
