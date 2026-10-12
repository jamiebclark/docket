import { openNotificationStream } from "@/server/services/notifications/stream";

export const dynamic = "force-dynamic";

/** The push behind the header bell (045). Admission and framing live in `openNotificationStream`. */
export async function GET(request: Request): Promise<Response> {
  return openNotificationStream(request);
}
