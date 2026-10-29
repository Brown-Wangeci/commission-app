import { describe, expect, it } from "vitest";
import { visibleTiles } from "@/components/review/EvidenceStrip";
import type { EvidenceView } from "@/lib/review/detail";

/** Issue #50: a flagged photo's reason is always on screen, never behind "View all". */
function photo(sequence: number, flag: string | null = null): EvidenceView {
  return {
    id: `p${sequence}`, sequence, kind: "photo", fieldKey: "field_1", capturedAt: null, gpsLat: null, gpsLon: null,
    gpsAccuracyM: null, locationSource: "device", kmOutsideArea: flag ? 1.5 : 0, flag, fromRequestId: null, url: "",
  };
}

describe("evidence grid tiles (issue #50)", () => {
  it("shows every photo when they fit without an overflow tile", () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => photo(n));
    expect(visibleTiles(six).map((p) => p.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gives flagged photos the visible places first, keeping evidence order", () => {
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => photo(n, n === 6 || n === 8 ? "Taken 1.5 km outside the job area" : null));
    expect(visibleTiles(eight).map((p) => p.sequence)).toEqual([1, 2, 3, 6, 8]);
  });

  it("shows the first five in order when nothing is flagged", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => photo(i + 1));
    expect(visibleTiles(twelve).map((p) => p.sequence)).toEqual([1, 2, 3, 4, 5]);
  });
});
