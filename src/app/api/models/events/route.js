import { getModelCatalogEmitter, getModelCatalogVersion } from "@/lib/modelCatalogEvents";

export const dynamic = "force-dynamic";

// SSE stream that notifies connected clients whenever the provider / combo /
// model registry changes, so model dropdowns can refresh immediately instead
// of waiting for their next poll.
export async function GET(request) {
  const encoder = new TextEncoder();
  const emitter = getModelCatalogEmitter();
  const state = { closed: false, send: null, keepalive: null };

  // Idempotent: safe to call from abort, cancel(), or an enqueue failure.
  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) emitter.off("changed", state.send);
    if (state.keepalive) clearInterval(state.keepalive);
  };

  request.signal.addEventListener("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    start(controller) {
      // Handshake so the client knows the stream is live.
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "init", version: getModelCatalogVersion() })}\n\n`));

      state.send = (payload) => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "changed", ...payload })}\n\n`));
        } catch {
          cleanup();
        }
      };

      emitter.on("changed", state.send);

      // Keepalive ping every 25s to survive idle proxies.
      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
