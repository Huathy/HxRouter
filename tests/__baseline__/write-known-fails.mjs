// Sinh lại tests/__baseline__/known-fails.txt từ một lần chạy vitest --reporter=json.
//
// Chỉ chạy khi đã cố ý sửa hết một nhóm lỗi và muốn ghi nhận phần còn lại là
// "đã biết". Mỗi dòng phải kèm lý do trong PR — thêm dòng chỉ để cho xong là
// đúng thứ gate này sinh ra để chặn.
//
// Usage: node tests/__baseline__/write-known-fails.mjs <current-results.json>
import { readFileSync, writeFileSync } from "fs";

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));

function normalizeTestPath(name) {
  const unified = name.replace(/\\/g, "/");
  const idx = unified.lastIndexOf("/tests/");
  return idx === -1 ? unified : unified.slice(idx + 1);
}

const lines = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => normalizeTestPath(f.name) + " :: " + a.fullName)
).sort();

const out = new URL("./known-fails.txt", import.meta.url);
writeFileSync(out, lines.length ? lines.join("\n") + "\n" : "");
console.log(`Wrote ${lines.length} known-fail line(s) to tests/__baseline__/known-fails.txt`);
