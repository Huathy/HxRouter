import { describe, it, expect, afterEach, vi } from "vitest";

// zh-CN deliberately contains a 设置 -> 配置 chain: it is what makes the
// double-translation regression observable (see the self-write guard test).
const LITERALS = {
  vi: { Settings: "Cài đặt" },
  ja: { Settings: "設定" },
  "zh-CN": { Settings: "设置", Profile: "个人资料", 设置: "配置" },
  "zh-TW": { Settings: "設定" },
};

const element = (tagName = "div") => ({
  tagName: tagName.toUpperCase(),
  parentElement: null,
  classList: { contains: () => false },
  hasAttribute: () => false,
});

const textNode = (value) => ({ nodeType: 3, nodeValue: value, parentElement: element("span") });

// runtime.js is module-level stateful and guarded on `typeof window`, so each
// test gets a fresh module instance plus a minimal fake DOM/fetch environment.
async function setup(locale, nodes) {
  vi.resetModules();
  const cookie = { value: `locale=${locale}` };
  const state = { requests: [], observers: [] };
  let queue = nodes;

  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    get cookie() { return cookie.value; },
    body: element("body"),
    createTreeWalker: () => { let i = 0; return { nextNode: () => queue[i++] || null }; },
  });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  vi.stubGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  vi.stubGlobal("MutationObserver", class {
    constructor(callback) { this.callback = callback; state.observers.push(this); }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    state.requests.push(url);
    const key = url.split("/").pop().replace(".json", "");
    return { json: async () => LITERALS[key] || {} };
  }));

  const runtime = await import("../../src/i18n/runtime.js");
  return { runtime, state, cookie };
}

// A real MutationRecord always carries addedNodes/removedNodes (empty for
// characterData), so the stubbed record keeps that shape.
const textMutation = (node) => ({ type: "characterData", target: node, addedNodes: [] });

afterEach(() => vi.unstubAllGlobals());

describe("runtime i18n", () => {
  it("fetches each locale file at most once per page session (L1-1)", async () => {
    const { runtime, state, cookie } = await setup("vi", [textNode("Settings")]);
    await runtime.initRuntimeI18n();
    expect(state.requests).toEqual(["/i18n/literals/vi.json"]);

    // Route change re-runs reloadTranslations, which must not refetch.
    await runtime.reloadTranslations();
    expect(state.requests).toHaveLength(1);

    // A -> B -> A: A is served from the cache, and en stays short-circuited.
    cookie.value = "locale=ja";
    await runtime.reloadTranslations();
    cookie.value = "locale=vi";
    await runtime.reloadTranslations();
    cookie.value = "locale=en";
    await runtime.reloadTranslations();
    expect(state.requests).toEqual(["/i18n/literals/vi.json", "/i18n/literals/ja.json"]);
    expect(runtime.getCurrentLocale()).toBe("en");
    expect(runtime.translate("Settings")).toBe("Settings");
  });

  it("re-translates React characterData updates (L1-2)", async () => {
    const node = textNode("Settings");
    const { runtime, state } = await setup("zh-CN", [node]);
    await runtime.initRuntimeI18n();
    expect(node.nodeValue).toBe("设置");

    // React 19 commitTextUpdate assigns textInstance.nodeValue => characterData.
    node.nodeValue = "Profile";
    state.observers[0].callback([textMutation(node)]);
    expect(node.nodeValue).toBe("个人资料");
  });

  it("ignores its own writes instead of translating twice (L1-2 guard)", async () => {
    const node = textNode("Settings");
    const { runtime, state } = await setup("zh-CN", [node]);
    await runtime.initRuntimeI18n();
    expect(node.nodeValue).toBe("设置");

    // The write processTextNode just made is also delivered as characterData.
    state.observers[0].callback([textMutation(node)]);
    // zh-CN maps 设置 -> 配置, so a clobbered _originalText lands here.
    expect(node.nodeValue).toBe("设置");
    expect(node._originalText).toBe("Settings");

    // Original intact, so the next React update still translates correctly.
    node.nodeValue = "Profile";
    state.observers[0].callback([textMutation(node)]);
    expect(node.nodeValue).toBe("个人资料");
  });

  it("falls back from zh-TW to zh-CN literals (L1-3)", async () => {
    const { runtime, state } = await setup("zh-TW", [textNode("Profile")]);
    await runtime.initRuntimeI18n();

    expect(state.requests).toEqual(["/i18n/literals/zh-TW.json", "/i18n/literals/zh-CN.json"]);
    expect(runtime.translate("Profile")).toBe("个人资料");
    expect(runtime.translate("Settings")).toBe("設定");

    await runtime.reloadTranslations();
    expect(state.requests).toHaveLength(2);
  });
});
