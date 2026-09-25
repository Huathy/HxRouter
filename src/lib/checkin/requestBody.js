const DEFAULT_MAX_BYTES = 64 * 1024;

export async function readBoundedJson(request, maxBytes = DEFAULT_MAX_BYTES) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBytes) return { error: "Request body is too large" };
  try {
    if (!request.body?.getReader) {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) return { error: "Request body is too large" };
      return { body: JSON.parse(text) };
    }
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { error: "Request body is too large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { error: "Invalid JSON" };
  }
}
