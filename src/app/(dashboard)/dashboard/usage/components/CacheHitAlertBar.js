"use client";

// Persistent prompt-cache regression alert.
//
// Deliberately NOT a toast. `notificationStore.warning()` is a 5-second toast:
// it vanishes when the tab is backgrounded and leaves no trace, which is the
// wrong shape for "the thing you are paying for has quietly stopped working".
// This bar stays until the condition clears or the user dismisses it, and the
// dismissal is keyed on the hour bucket so the next distinct drop can still be
// surfaced.
import { useEffect, useState } from "react";
import { detectCacheHitDrop, cacheBucketKey } from "@/shared/utils/cacheHitAlert";

const REFRESH_MS = 5 * 60 * 1000;

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

export default function CacheHitAlertBar() {
  const [drop, setDrop] = useState(null);
  const [dismissedBucket, setDismissedBucket] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        // The trend is a server-side DB read. Importing the repo here would drag
        // the SQLite driver and undici into the client bundle and break the build.
        const res = await fetch("/api/usage/cache-hit?hours=12", { cache: "no-store" });
        if (!res.ok) throw new Error(`cache-hit trend unavailable: ${res.status}`);
        const buckets = await res.json();
        if (cancelled) return;
        const result = detectCacheHitDrop(buckets);
        setDrop(result.status === "drop" ? result : null);
      } catch {
        // A failed trend read must not surface as a false regression.
        if (!cancelled) setDrop(null);
      }
    };

    check();
    const timer = setInterval(check, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!drop) return null;

  // Keyed on the HOUR the bucket falls in, not on the raw bucketStart: the server
  // anchors its grid at the request time, so the current (partial) hour's
  // bucketStart moves on every poll and a raw comparison would never match —
  // the alert a user just dismissed would come back 5 minutes later, forever.
  const bucketKey = cacheBucketKey(drop.current?.bucketStart);
  if (bucketKey === null || bucketKey === dismissedBucket) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <span className="material-symbols-outlined shrink-0 text-[20px]">warning</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">Prompt cache hit rate dropped</p>
        <p className="mt-0.5 text-xs opacity-90">
          The last hour ran at {pct(drop.current.hitRate)} against a{" "}
          {pct(drop.baselineHitRate)} baseline over the preceding hours. Cache
          reads are billed at a lower rate, so this is costing more per request
          than usual. Check whether the client is still sending a stable cache
          key or the upstream stopped honouring it.
        </p>
      </div>
      <button
        type="button"
        onClick={() => setDismissedBucket(bucketKey)}
        className="shrink-0 rounded px-2 py-1 text-xs underline underline-offset-2 opacity-80 transition-opacity hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
}
