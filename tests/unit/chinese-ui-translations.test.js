import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REQUIRED_KEYS = [
  "Success Rate",
  "Speed",
  "Model Pricing",
  "Proxy Fitness",
  "models",
  "source",
  "last sync",
  "Never",
  "just now",
  "minutes ago",
  "hours ago",
  "days ago",
];

describe("Chinese dashboard translations", () => {
  for (const locale of ["zh-CN", "zh-TW"]) {
    it(`includes requested usage and pricing labels for ${locale}`, () => {
      const path = new URL(`../../public/i18n/literals/${locale}.json`, import.meta.url);
      const messages = JSON.parse(readFileSync(path, "utf8"));

      for (const key of REQUIRED_KEYS) {
        expect(messages[key], key).toBeTruthy();
      }
    });
  }
});
