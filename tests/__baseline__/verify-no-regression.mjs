// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào fail(now) mà chưa nằm trong baseline known-fails.
// Dùng để chặn "đỏ file nào đó thì thêm vào known-fails cho xong" — mỗi dòng baseline
// phải kèm lý do.
//
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
//
// Sinh lại baseline sau khi cố ý sửa hết một nhóm lỗi (chạy `pnpm test:baseline:refresh`):
// mỗi dòng mới phải kèm lý do trong PR, không thêm dòng để "cho xanh".
import { readFileSync } from "fs";

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));

/**
 * Chuẩn hoá đường dẫn file test về `tests/...` bất kể máy build.
 *
 * Bản cũ dùng `f.name.split("/app/")[1]`, chỉ đúng trên container có prefix
 * `/app/`. Trên Windows path là `D:/works/.../HxRouter/tests/unit/foo.test.js`
 * nên `split("/app/")[1]` là `undefined` → key thành `"undefined :: ..."`, không
 * bao giờ giao với `known-fails.txt` → luôn báo toàn bộ là regression.
 *
 * Bắt đầu từ segment `tests/` thay vì phụ thuộc prefix đường dẫn, và chuẩn hoá
 * separator về `/` để key ổn định giữa Windows/POSIX.
 */
function normalizeTestPath(name) {
  const unified = name.replace(/\\/g, "/");
  const idx = unified.lastIndexOf("/tests/");
  return idx === -1 ? unified : unified.slice(idx + 1);
}

const nowFails = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => normalizeTestPath(f.name) + " :: " + a.fullName)
);

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
