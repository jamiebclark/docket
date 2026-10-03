import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth/auth";

// Built lazily so `next build` needs no secrets.
const handlers = () => toNextJsHandler(getAuth());

export const GET = (request: Request) => handlers().GET(request);
export const POST = (request: Request) => handlers().POST(request);
export const PATCH = (request: Request) => handlers().PATCH(request);
export const PUT = (request: Request) => handlers().PUT(request);
export const DELETE = (request: Request) => handlers().DELETE(request);
