// Draft-Umschaltung ohne useSearchParams (Fund 2, PR 5).
//
// `/transactions/new` liefert offline (Service-Worker networkFirst,
// ignoreSearch-Fallback) das QUERY-FREIE, vorgewärmte Dokument aus — ein
// `?draft=<id>` erreicht den Server-Render in diesem Fall nie. Die Draft-
// Kennung muss deshalb im URL-FRAGMENT stehen, das der Browser nie an den
// Server schickt und das daher auch die Offline-Auslieferung übersteht.
//
// Vor dem Fix gab es dieses Modul (und damit einen fragment-basierten Pfad)
// schlicht nicht — der Import allein schlägt gegen den alten Stand fehl.
import { describe, expect, it } from "vitest";
import { draftEditHref, readDraftIdFromHash } from "@/lib/offline/draft-hash";

describe("draftEditHref / readDraftIdFromHash (Fund 2, PR 5)", () => {
  it("baut den Bearbeiten-Link mit einem Fragment, nicht mit einem Query-String", () => {
    const href = draftEditHref("trip-1", "outbox-abc");
    expect(href).toBe("/trips/trip-1/transactions/new#draft=outbox-abc");
    expect(href).not.toContain("?draft=");
  });

  it("liest die Draft-ID aus dem Fragment zurück", () => {
    expect(readDraftIdFromHash("#draft=outbox-abc")).toBe("outbox-abc");
  });

  it("dekodiert URI-kodierte Zeichen in der ID", () => {
    expect(readDraftIdFromHash("#draft=a%20b")).toBe("a b");
  });

  it("liefert null ohne Fragment oder bei einem Query-String im Fragment-Feld", () => {
    expect(readDraftIdFromHash("")).toBeNull();
    expect(readDraftIdFromHash("#other")).toBeNull();
  });

  it("überlebt einen Fragment-Roundtrip mit Sonderzeichen in der ID", () => {
    const id = "id-with-special/chars=1";
    const href = draftEditHref("t", id);
    const hash = href.slice(href.indexOf("#"));
    expect(readDraftIdFromHash(hash)).toBe(id);
  });
});
