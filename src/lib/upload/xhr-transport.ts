import type { Transport } from "./engine";

/** Browser transport: XHR, because `fetch` cannot report upload progress (research §4). Status 0 = network failure. */
export const xhrTransport: Transport = {
  sendPart(url, blob, { onProgress, signal }) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
      xhr.onload = () => {
        let message: string | undefined;
        try {
          const body = JSON.parse(xhr.responseText) as { message?: unknown };
          if (typeof body.message === "string") message = body.message;
        } catch {
          // Not JSON (storage answers in XML, or with nothing).
        }
        resolve({ status: xhr.status, ...(message ? { message } : {}) });
      };
      xhr.onerror = () => resolve({ status: 0 });
      xhr.ontimeout = () => resolve({ status: 0 });
      signal.addEventListener("abort", () => {
        xhr.abort();
        reject(new DOMException("Aborted", "AbortError"));
      });
      xhr.send(blob);
    });
  },
};
