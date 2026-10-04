import { ApiError, type ApiErrorBody } from "./errors";

const JSON_TYPE = "application/json; charset=utf-8";

export function baseHeaders(requestId: string, extra?: Record<string, string>): Headers {
  const h = new Headers(extra);
  h.set("X-Request-Id", requestId);
  h.set("Cache-Control", "no-store");
  return h;
}

export function json(requestId: string, status: number, body: unknown, extra?: Record<string, string>): Response {
  const h = baseHeaders(requestId, extra);
  h.set("Content-Type", JSON_TYPE);
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function errorBody(e: ApiError, requestId: string): ApiErrorBody {
  return {
    error: {
      code: e.code,
      message: e.message,
      ...(e.details === undefined ? {} : { details: e.details }),
      requestId,
    },
  };
}

export function errorResponse(requestId: string, e: ApiError): Response {
  return json(requestId, e.status, errorBody(e, requestId), e.headers);
}
