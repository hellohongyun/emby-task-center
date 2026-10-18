import type { ScannedMediaBatch, ScanOutput } from "./scan-types";

/** Legacy scanners may update records, but cannot authorize removal of unseen ones. */
export function checkedScanResult(output: ScanOutput): ScannedMediaBatch {
  if (Array.isArray(output)) return { items: output, complete: false };
  const batch = output as ScannedMediaBatch;
  if (!batch.complete) throw new Error("library_scan_incomplete");
  return batch;
}
