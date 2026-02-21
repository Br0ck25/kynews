export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): never {
  throw new ApiError(400, message, details);
}

export function unauthorized(message = "Unauthorized"): never {
  throw new ApiError(401, message);
}

export function forbidden(message = "Forbidden"): never {
  throw new ApiError(403, message);
}

export function notFound(message = "Not found"): never {
  throw new ApiError(404, message);
}

export function tooManyRequests(message = "Too many requests"): never {
  throw new ApiError(429, message);
}

export function badGateway(message = "Bad gateway"): never {
  throw new ApiError(502, message);
}

export function unsupportedMedia(message = "Unsupported media type"): never {
  throw new ApiError(415, message);
}
