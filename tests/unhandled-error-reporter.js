// Vitest reporter: fail loudly on unhandled errors.
//
// A single aborted server used to leave dozens of in-flight fetches rejecting
// with nobody listening. Vitest counted them ("Errors 100") *after* printing a
// mostly-green summary, so the run looked like a handful of unrelated red files
// and the root cause was easy to mis-attribute. This reporter groups the
// unhandled errors, attributes them to the file that produced them, and makes
// them the first thing you read instead of a footnote.
//
// It never hides a failure — the run still fails either way. It only changes
// where the information surfaces, so the count cannot be skimmed past.
const unhandledByFile = new Map();

export default class UnhandledErrorReporter {
  onUnhandledError(error) {
    // Vitest passes the error; the owning file is on the error's task frame when
    // available, otherwise it is attributed to "(unknown)".
    const file = error?.file?.name || error?.testFile || "(unknown)";
    if (!unhandledByFile.has(file)) unhandledByFile.set(file, []);
    unhandledByFile.get(file).push(error);
  }

  onTestRunEnd() {
    if (unhandledByFile.size === 0) return;

    const total = [...unhandledByFile.values()].reduce((n, list) => n + list.length, 0);
    const lines = [];
    for (const [file, list] of unhandledByFile) {
      lines.push(`  ${file} — ${list.length} unhandled error(s)`);
      const sample = list[0]?.message?.split("\n")[0] ?? String(list[0]);
      lines.push(`      e.g. ${sample}`);
    }
    this.ctx?.logger?.log(
      `\n[unhandled] ${total} unhandled error(s) from ${unhandledByFile.size} file(s):\n${lines.join("\n")}\n`
    );
  }
}
