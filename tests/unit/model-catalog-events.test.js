import { describe, it, expect, afterEach } from "vitest";
import { GET } from "@/app/api/models/events/route.js";
import { notifyModelCatalogChanged, getModelCatalogVersion } from "@/lib/modelCatalogEvents.js";

function makeRequest() {
  return new Request("https://9router.local/api/models/events");
}

async function readEvent(reader) {
  const { value } = await reader.read();
  return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "").trim());
}

describe("model catalog events stream", () => {
  let reader = null;

  afterEach(async () => {
    if (reader) {
      await reader.cancel();
      reader = null;
    }
  });

  it("streams an init event, then a changed event on notify", async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    reader = response.body.getReader();

    const init = await readEvent(reader);
    expect(init.type).toBe("init");
    expect(typeof init.version).toBe("number");

    const before = getModelCatalogVersion();
    notifyModelCatalogChanged("test");

    const changed = await readEvent(reader);
    expect(changed.type).toBe("changed");
    expect(changed.reason).toBe("test");
    expect(changed.version).toBe(before + 1);
  });
});
