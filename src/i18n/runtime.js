"use client";

import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "./config";

let translationMap = {};
let currentLocale = DEFAULT_LOCALE;
let reloadCallbacks = [];

// Locales whose own literals are far from complete: zh-TW ships ~270 of the
// ~1464 keys zh-CN has, so a zh-TW user would see English for ~1194 strings.
// The locale's own literals win over the fallback's.
//
// Deliberately NOT configured: pt-BR <-> pt-PT (~196 keys each, so the merged
// map would gain almost nothing) and fa/th -> en (translate() already returns
// the original text on a miss, which is exactly the en behaviour — a no-op).
const LOCALE_FALLBACKS = {
  "zh-TW": "zh-CN",
};

// Per-page-session cache of loaded literal files, keyed by locale. Values are
// in-flight promises, so concurrent callers dedupe on the same request. A load
// that fails is evicted so a later navigation can retry.
const localeLiterals = new Map();

// Read locale from cookie
function getLocaleFromCookie() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : DEFAULT_LOCALE;
  return normalizeLocale(value);
}

// Fetch one locale's literals, at most once per page session
async function requestLocaleLiterals(locale) {
  const response = await fetch(`/i18n/literals/${locale}.json`);
  return response.json();
}

function fetchLocaleLiterals(locale) {
  const cached = localeLiterals.get(locale);
  if (cached) return cached;

  const pending = requestLocaleLiterals(locale).catch((err) => {
    console.error("Failed to load translations:", err);
    localeLiterals.delete(locale);
    return {};
  });

  localeLiterals.set(locale, pending);
  return pending;
}

// Load translation map
async function loadTranslations(locale) {
  if (locale === "en") {
    translationMap = {};
    return;
  }

  const fallbackLocale = LOCALE_FALLBACKS[locale];

  if (fallbackLocale) {
    // Costs one extra request the first time this locale is used; both files
    // are then served from the session cache like any other locale.
    const [own, fallback] = await Promise.all([
      fetchLocaleLiterals(locale),
      fetchLocaleLiterals(fallbackLocale),
    ]);
    translationMap = { ...fallback, ...own };
    return;
  }

  translationMap = await fetchLocaleLiterals(locale);
}

// Translate text - exported for use in components
export function translate(text) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (currentLocale === "en") return text;
  return translationMap[trimmed] || text;
}

// Get current locale - exported for use in components
export function getCurrentLocale() {
  return currentLocale;
}

// Register callback for locale changes
export function onLocaleChange(callback) {
  reloadCallbacks.push(callback);
  return () => {
    reloadCallbacks = reloadCallbacks.filter(cb => cb !== callback);
  };
}

// Process text node
function processTextNode(node) {
  if (!node.nodeValue || !node.nodeValue.trim()) return;
  
  // Skip if parent is script, style, code, or structural elements
  const parent = node.parentElement;
  if (!parent) return;
  
  // Skip if parent or any ancestor has data-i18n-skip attribute
  let element = parent;
  while (element) {
    if (element.hasAttribute && element.hasAttribute('data-i18n-skip')) {
      return;
    }
    element = element.parentElement;
  }
  
  const tagName = parent.tagName?.toLowerCase();
  
  // Skip elements that don't allow text nodes or icon font ligature containers
  const skipTags = [
    "script", "style", "code", "pre",
    "colgroup", "table", "thead", "tbody", "tfoot", "tr",
    "select", "datalist", "optgroup"
  ];
  
  if (skipTags.includes(tagName)) return;

  // Never translate text nodes inside icon font containers (Material Symbols/Icons)
  // because icon ligature strings (e.g. "search", "close", "edit", "menu") will be
  // translated into foreign text (e.g. "بحث", "关闭", "Suchen"), breaking icon rendering.
  const classList = parent.classList;
  if (
    classList &&
    (classList.contains("material-symbols-outlined") ||
      classList.contains("material-symbols") ||
      classList.contains("material-icons") ||
      classList.contains("material-icons-outlined"))
  ) {
    return;
  }
  
  // Store original text if not already stored
  if (!node._originalText) {
    node._originalText = node.nodeValue;
  }
  
  // Use original text for translation
  const original = node._originalText;
  const translated = translate(original);
  
  // Only update if different to avoid unnecessary DOM mutations
  if (translated !== node.nodeValue) {
    node.nodeValue = translated;
    // Record the exact value the runtime last wrote, so the characterData
    // observer can recognise its own mutation and leave _originalText alone.
    node._translatedText = translated;
  }
}

// Process all text nodes in element
function processElement(element) {
  if (!element) return;
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  let node;
  const nodesToProcess = [];
  
  // Collect all nodes first to avoid live collection issues
  while ((node = walker.nextNode())) {
    nodesToProcess.push(node);
  }
  
  // Process collected nodes
  nodesToProcess.forEach(processTextNode);
}

// Initialize runtime i18n
export async function initRuntimeI18n() {
  if (typeof window === "undefined") return;
  
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Process existing DOM
  processElement(document.body);
  
  // Watch for new nodes and for React text updates
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      // React 19's commitTextUpdate writes textInstance.nodeValue, which is a
      // characterData mutation — a childList-only observer never sees it, so
      // re-rendered text stayed English.
      if (mutation.type === "characterData") {
        const node = mutation.target;
        // Skip the runtime's own write, otherwise _originalText would be
        // overwritten with the already-translated string and the text would be
        // translated again on top of its own output.
        if (node.nodeValue === node._translatedText) return;
        // A foreign write (React re-render): treat the new value as the new
        // source text and translate from it.
        node._translatedText = null;
        node._originalText = node.nodeValue;
        processTextNode(node);
        return;
      }

      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processElement(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          processTextNode(node);
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

// Reload translations when locale changes
export async function reloadTranslations() {
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Notify all registered callbacks
  reloadCallbacks.forEach(callback => callback());
  
  // Re-process entire DOM (will use stored original text)
  processElement(document.body);
}
