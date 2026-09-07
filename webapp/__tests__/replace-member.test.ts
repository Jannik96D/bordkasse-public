// replaceMember (Crewwechsel A → B) — lib/actions/prepayments.ts.
//
// Historie (Fund 1-4, Grill-Reviews vor PR 4):
//  1. Der Payment-Transfer-Query filterte nicht auf confirmed_at, hätte
//     also eine unbestätigte Selbstmeldung wie eine echte Zahlung
//     übernommen.
//  2. Der Pre-Check auf eine offene Selbstmeldung muss vor JEDER
//     Schreib-Operation laufen — sonst hinterlässt ein abgelehnter Wechsel
//     trotzdem schon eine Ghost-Person + Creweintrag (Orphan).
//  3. Eine new_email, die schon zu einem ANDEREN Crewmitglied desselben
//     Törns gehört, hätte dessen trip_members-/Obligation-Zeile
//     stillschweigend überschrieben statt abzulehnen.
//  4. Idempotenz (Grill-Review, Fund 3): Netzwerk-Retry (flakey Yacht-WLAN)
//     durfte weder die neue Person noch den Zahlungstransfer duplizieren.
//
// PR 4 (dieser Satz Tests): fünf weitere Fixe, gefunden beim Sanierungsplan
// für das Bilanz-Verhalten nach einem Crewwechsel:
//  A. Bestätigte Gutschriften von A werden jetzt per UPDATE direkt auf B
//     umgehängt (credit_from), statt eine synthetische "B → A"-Gegen-
//     Gutschrift zu erzeugen. Grund: v_balances ist rein mitgliedschafts-
//     getrieben (FROM trip_members, siehe 0043_review_fixes_q4_q5_q6.sql)
//     — eine Zeile mit credit_from auf eine nicht mehr in trip_members
//     stehende Person fällt aus der Bilanz-Summe heraus (Geld "verdunstet").
//     Selbst-Verrechnungen (credit_from = credit_to) werden NICHT umgehängt.
//  B. Der Vorstrecker der Anzahlung (prepayment_plan.advancer_person_id)
//     darf nicht über diesen Pfad ersetzt werden — das gehört in den
//     Anzahlungs-Wizard.
//  C. VOR jeder Schreib-Operation wird geprüft, ob nach dem (gedanklichen)
//     Umhängen aus A noch eine Buchungsspur übrig bliebe (paid_by/
//     credit_to/transaction_participants) — sonst dürfte trip_members NICHT
//     gelöscht werden. Ersetzt den früheren, semantisch verkehrten
//     on_board_from/on_board_to = NULL-Trick (NULL bedeutet laut Schema
//     "volle Anwesenheit", nicht "abgereist").
//  D. Vor dem Löschen der alten Mitgliedschaft wird — falls A schon mal
//     eingeloggt war (auth_user_id gesetzt) — eine trip_statistics_audience-
//     Zeile für A geschrieben, damit A den Törn nicht aus /stats verliert.
//  E. Die alte trip_members-Zeile wird jetzt WIRKLICH gelöscht (DELETE),
//     nicht mehr nur auf on_board_from/on_board_to = NULL gesetzt.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
  requireMember: vi.fn(),
  requireSkipperAdminOrAdvancer: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import { replaceMember } from "@/lib/actions/prepayments";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperOrAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedAuth = vi.mocked(requireSkipperOrAdmin);
const mockedAdminClient = vi.mocked(createAdminClient);

// RFC-4122-valide Seed-UUIDs (Zod v4 .uuid() ist strikt).
const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SKIPPER_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const OLD_PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const ACTOR_ID = "aaaaaaaa-0000-4000-8000-000000000004";
const OLD_MEMBER_ROW_ID = "aaaaaaaa-0000-4000-8000-000000000005";
const CABIN_ID = "aaaaaaaa-0000-4000-8000-000000000006";
const TRANCHE_ID = "aaaaaaaa-0000-4000-8000-000000000007";
const EXISTING_MEMBER_PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000008";
const EXISTING_MEMBER_ROW_ID = "aaaaaaaa-0000-4000-8000-000000000009";
const NEW_PERSON_ID = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER_PERSON_ID = "aaaaaaaa-0000-4000-8000-00000000000b";

const CONFIRMED_PAYMENT = {
  id: "aaaaaaaa-0000-4000-8000-0000000000c1",
  trip_id: TRIP_ID,
  credit_from: OLD_PERSON_ID,
  credit_to: SKIPPER_ID, // A hat an den (damaligen) Vorstrecker gezahlt
  type: "credit",
  tranche_id: TRANCHE_ID,
  deleted_at: null,
  confirmed_at: "2026-08-01T10:00:00Z",
  amount: 202.5,
  date: "2026-08-01",
};

// Zweite, UNABHÄNGIGE Zahlung mit exakt demselben Betrag + Datum wie
// CONFIRMED_PAYMENT (z.B. zwei gleich große Tranchen, am selben Tag
// bestätigt) — der Regressionsfall für Fund 1 aus dem Grill-Review.
const CONFIRMED_PAYMENT_SAME_AMOUNT_AND_DATE = {
  ...CONFIRMED_PAYMENT,
  id: "aaaaaaaa-0000-4000-8000-0000000000c2",
  tranche_id: "aaaaaaaa-0000-4000-8000-0000000000c3",
};

const PENDING_SELF_REPORT = {
  id: "aaaaaaaa-0000-4000-8000-0000000000c9",
  trip_id: TRIP_ID,
  credit_from: OLD_PERSON_ID,
  credit_to: SKIPPER_ID,
  type: "credit",
  tranche_id: TRANCHE_ID,
  deleted_at: null,
  confirmed_at: null, // unbestätigte Selbstmeldung
  amount: 999,
  date: "2026-08-02",
};

type Call = { table: string; op: string; payload?: unknown };

type MockOpts = {
  /** Zusätzliche transaction_participants-Zeilen (Fix C, Restspur-Check). */
  participantsRows?: Array<Record<string, unknown>>;
  /** prepayment_plan-Zeile — steuert den Vorstrecker-Check (Fix B). */
  planRow?: { trip_id: string; advancer_person_id: string | null } | null;
  /** persons-Zeile für old_person_id — steuert den Audience-Check (Fix D). */
  oldPersonRow?: { id: string; auth_user_id: string | null } | null;
};

/**
 * Minimaler In-Memory-Postgrest-Mock: `.eq`/`.not`/`.is`/`.or` filtern die
 * kanonischen Zeilen im "select"-Modus wirklich (inkl. `.or()` mit dem
 * PostgREST-"col.eq.val,col2.eq.val2"-Format, wie es
 * lib/auth/cross-trip.ts:personHasBookingTrace nutzt).
 */
function makeSupabase(calls: Call[], transactionsRows: Array<Record<string, unknown>>, opts: MockOpts = {}) {
  const writeReturns: Record<string, (payload: unknown) => unknown> = {
    persons: (payload) => ({ id: (payload as { id?: string })?.id ?? "new-person-id" }),
    trip_members: () => ({ id: "new-member-id" }),
  };
  const readData: Record<string, Array<Record<string, unknown>>> = {
    trips: [{ id: TRIP_ID, skipper_id: SKIPPER_ID }],
    trip_members: [
      {
        id: OLD_MEMBER_ROW_ID,
        trip_id: TRIP_ID,
        person_id: OLD_PERSON_ID,
        on_board_from: null,
        on_board_to: null,
        is_alcoholic: null,
        note: null,
      },
      {
        id: EXISTING_MEMBER_ROW_ID,
        trip_id: TRIP_ID,
        person_id: EXISTING_MEMBER_PERSON_ID,
        on_board_from: null,
        on_board_to: null,
        is_alcoholic: null,
        note: null,
      },
    ],
    prepayment_obligations: [
      { trip_id: TRIP_ID, person_id: OLD_PERSON_ID, cabin_type_id: CABIN_ID, total_amount: 675 },
    ],
    persons_private: [{ person_id: EXISTING_MEMBER_PERSON_ID, email: "existing@example.com" }],
    persons: [
      { id: NEW_PERSON_ID, auth_user_id: null },
      opts.oldPersonRow ?? { id: OLD_PERSON_ID, auth_user_id: null },
    ],
    transactions: transactionsRows,
    transaction_participants: opts.participantsRows ?? [],
    prepayment_plan: opts.planRow ? [opts.planRow] : [],
    trip_statistics_audience: [],
  };

  const make = (table: string) => {
    let mode: "select" | "insert" | "upsert" | "update" | "delete" | null = null;
    let rows = [...(readData[table] ?? [])];
    let lastPayload: unknown;
    const insertError: { code: string; message: string } | null = null;
    const b: Record<string, unknown> = {};
    b.select = () => {
      if (mode === null) mode = "select";
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      if (mode === "select") rows = rows.filter((r) => r[col] === val);
      return b;
    };
    b.not = (col: string) => {
      if (mode === "select") rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
      return b;
    };
    b.is = (col: string, val: unknown) => {
      if (mode === "select") {
        rows = rows.filter((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
      }
      return b;
    };
    // PostgREST-OR-Format: "paid_by.eq.X,credit_to.eq.Y" — ODER-verknüpft.
    b.or = (expr: string) => {
      if (mode === "select") {
        const conds = expr.split(",").map((part) => {
          const [col, , ...rest] = part.split(".");
          return { col, val: rest.join(".") };
        });
        rows = rows.filter((r) => conds.some((c) => String(r[c.col]) === c.val));
      }
      return b;
    };
    b.in = (col: string, vals: unknown[]) => {
      if (mode === "select") rows = rows.filter((r) => (vals as unknown[]).includes(r[col]));
      if (mode === "update") calls[calls.length - 1] = { ...calls[calls.length - 1], payload: { ...(lastPayload as object), __in: { col, vals } } };
      return b;
    };
    b.insert = (payload: unknown) => {
      mode = "insert";
      lastPayload = payload;
      calls.push({ table, op: "insert", payload });
      return b;
    };
    b.upsert = (payload: unknown) => {
      mode = "upsert";
      lastPayload = payload;
      calls.push({ table, op: "upsert", payload });
      return b;
    };
    b.update = (payload: unknown) => {
      mode = "update";
      lastPayload = payload;
      calls.push({ table, op: "update", payload });
      return b;
    };
    b.delete = () => {
      mode = "delete";
      calls.push({ table, op: "delete" });
      return b;
    };
    b.maybeSingle = () => Promise.resolve(mode === "select" ? { data: rows[0] ?? null } : { data: null });
    b.single = () =>
      Promise.resolve(
        mode === "insert" || mode === "upsert"
          ? { data: insertError ? null : writeReturns[table]?.(lastPayload) ?? { id: "unknown" }, error: insertError }
          : { data: rows[0] ?? null, error: rows[0] ? null : { message: "not found" } },
      );
    b.then = (onFulfilled: (v: unknown) => unknown) => {
      const value =
        mode === "select" || mode === null
          ? { data: rows, error: null, count: rows.length }
          : { data: null, error: insertError };
      return Promise.resolve(value).then(onFulfilled);
    };
    return b;
  };
  return { from: (table: string) => make(table) };
}

function replaceFormData(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("trip_id", TRIP_ID);
  fd.set("old_person_id", OLD_PERSON_ID);
  fd.set("new_display_name", "Nachfolger");
  fd.set("new_email", "");
  fd.set("new_person_id", NEW_PERSON_ID);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

describe("replaceMember", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedAuth.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: ACTOR_ID, display_name: "Skipper" } as never);
    mockedAuth.mockResolvedValue({ ok: true, personId: ACTOR_ID } as never);
  });

  it("hängt eine bestätigte Gutschrift per UPDATE auf B um, statt eine neue Zeile anzulegen (Fix A)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    // Keine neue Transaktion mehr (alte Implementierung: synthetische
    // "B → A"-Gegen-Gutschrift per INSERT).
    const transactionInserts = calls.filter((c) => c.table === "transactions" && c.op === "insert");
    expect(transactionInserts).toHaveLength(0);

    // Stattdessen ein UPDATE, das credit_from der bestehenden Zeile ändert.
    const updates = calls.filter((c) => c.table === "transactions" && c.op === "update");
    expect(updates).toHaveLength(1);
    const payload = updates[0].payload as { credit_from: string; __in?: { col: string; vals: string[] } };
    expect(payload.credit_from).toBe(NEW_PERSON_ID);
    expect(payload.__in?.col).toBe("id");
    expect(payload.__in?.vals).toEqual([CONFIRMED_PAYMENT.id]);
  });

  it("hängt zwei unterschiedliche Zahlungen mit gleichem Betrag+Datum BEIDE um (Regression zu Fund 1)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [CONFIRMED_PAYMENT, CONFIRMED_PAYMENT_SAME_AMOUNT_AND_DATE]) as never,
    );

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    const updates = calls.filter((c) => c.table === "transactions" && c.op === "update");
    expect(updates).toHaveLength(1);
    const payload = updates[0].payload as { __in?: { vals: string[] } };
    expect(new Set(payload.__in?.vals).size).toBe(2);
    expect((payload.__in?.vals ?? []).sort()).toEqual(
      [CONFIRMED_PAYMENT.id, CONFIRMED_PAYMENT_SAME_AMOUNT_AND_DATE.id].sort(),
    );
  });

  it("hängt eine Selbst-Verrechnung (credit_from = credit_to) NICHT um (Fix A, Ausnahme)", async () => {
    const selfCredit = {
      ...CONFIRMED_PAYMENT,
      id: "aaaaaaaa-0000-4000-8000-0000000000c4",
      credit_to: OLD_PERSON_ID, // Selbst-Verrechnung
    };
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [selfCredit]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    // Die Selbst-Verrechnung ist zugleich eine "credit_to = old_person_id"-
    // Spur, die der Vorab-Check (Fix C) als blockierend zählt — der ganze
    // Wechsel muss also ABLEHNEN, statt die Zeile stillschweigend zu
    // übernehmen oder zu verlieren.
    expect(res.status).toBe("error");
    const updates = calls.filter((c) => c.table === "transactions" && c.op === "update");
    expect(updates).toHaveLength(0);
  });

  it("bricht VOR jeder Schreib-Operation ab, wenn A noch als Zahler (paid_by) einer Ausgabe auftaucht (Fix C)", async () => {
    const expenseByA = {
      id: "aaaaaaaa-0000-4000-8000-0000000000d1",
      trip_id: TRIP_ID,
      type: "expense",
      paid_by: OLD_PERSON_ID,
      credit_from: null,
      credit_to: null,
      tranche_id: null,
      deleted_at: null,
      confirmed_at: "2026-08-01T10:00:00Z",
      amount: 50,
      date: "2026-08-01",
    };
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [expenseByA]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/noch Buchungen/i);
    // Alles-oder-nichts: keine Person/Crew-Zeile angelegt.
    expect(calls.filter((c) => c.table === "persons")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "trip_members")).toHaveLength(0);
  });

  it("bricht ab, wenn A nur über transaction_participants an einer Buchung beteiligt ist (Fix C)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [], {
        participantsRows: [{ transaction_id: "tx-1", person_id: OLD_PERSON_ID, "transactions.trip_id": TRIP_ID, "transactions.deleted_at": null }],
      }) as never,
    );

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/noch Buchungen/i);
    expect(calls.filter((c) => c.table === "trip_members" && c.op !== undefined)).toHaveLength(0);
  });

  it("lässt den Wechsel zu, wenn A NUR reassignierbare credit_from-Zeilen hat (Fix C, kein Fehlalarm)", async () => {
    // Reine credit_from-Spur wird gleich umgehängt — darf NICHT als
    // blockierende Restspur zählen, sonst wäre kein Crewwechsel mit
    // Anzahlungs-Historie je möglich.
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });
  });

  it("lehnt den Wechsel ab, wenn A der Vorstrecker der Anzahlung ist (Fix B)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [CONFIRMED_PAYMENT], {
        planRow: { trip_id: TRIP_ID, advancer_person_id: OLD_PERSON_ID },
      }) as never,
    );

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/Vorstrecker/i);
    // Vor jeder Schreib-Operation: keine Person/Crew-Zeile angelegt.
    expect(calls).toHaveLength(0);
  });

  it("erlaubt den Wechsel, wenn EIN ANDERES Crewmitglied Vorstrecker ist (Fix B, kein Fehlalarm)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [CONFIRMED_PAYMENT], {
        planRow: { trip_id: TRIP_ID, advancer_person_id: OTHER_PERSON_ID },
      }) as never,
    );

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });
  });

  it("schreibt eine trip_statistics_audience-Zeile für A, wenn A bereits eingeloggt war (Fix D)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [CONFIRMED_PAYMENT], {
        oldPersonRow: { id: OLD_PERSON_ID, auth_user_id: "auth-old-1" },
      }) as never,
    );

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    const audienceUpserts = calls.filter((c) => c.table === "trip_statistics_audience" && c.op === "upsert");
    expect(audienceUpserts).toHaveLength(1);
    expect(audienceUpserts[0].payload).toMatchObject({ person_id: OLD_PERSON_ID, trip_id: TRIP_ID });
  });

  it("schreibt KEINE trip_statistics_audience-Zeile, wenn A sich nie eingeloggt hat (Fix D, kein Fehlalarm)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [CONFIRMED_PAYMENT], {
        oldPersonRow: { id: OLD_PERSON_ID, auth_user_id: null },
      }) as never,
    );

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });
    expect(calls.filter((c) => c.table === "trip_statistics_audience")).toHaveLength(0);
  });

  it("löscht die alte trip_members-Zeile wirklich (DELETE), statt sie nur auf NULL zu setzen (Fix E)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    // NULL bei on_board_from/on_board_to bedeutet laut Schema "volle
    // Anwesenheit" — ein UPDATE auf die alte Zeile wäre also das Gegenteil
    // von "A ist abgereist". Es darf daher keinerlei UPDATE auf
    // trip_members(id = OLD_MEMBER_ROW_ID) mehr geben, nur ein DELETE.
    const memberUpdates = calls.filter((c) => c.table === "trip_members" && c.op === "update");
    expect(memberUpdates).toHaveLength(0);
    const memberDeletes = calls.filter((c) => c.table === "trip_members" && c.op === "delete");
    expect(memberDeletes).toHaveLength(1);
  });

  it("fängt eine Buchung ab, die ZWISCHEN dem Vorab-Check und dem finalen DELETE für A entsteht (Race, Grill-Review-Fund)", async () => {
    // Der Vorab-Check (Fix C) lief ganz am Anfang der Funktion, bevor
    // irgendetwas geschrieben wurde. Dazwischen und dem finalen DELETE
    // liegen mehrere DB-Roundtrips (Personen-/Crew-Anlage, Obligation-
    // Transfer, Credit-Reassign, Audience-Upsert) ohne Transaktion. Dieser
    // Test simuliert eine Buchung, die GENAU in diesem Fenster entsteht
    // (z.B. ein paralleler createExpense-Aufruf eines anderen Nutzers) —
    // per Side-Effect am ersten trip_members-Upsert (Schritt 4, läuft nach
    // dem Vorab-Check, aber vor dem finalen Re-Check).
    const calls: Call[] = [];
    const transactionsRows: Array<Record<string, unknown>> = [CONFIRMED_PAYMENT];
    const base = makeSupabase(calls, transactionsRows);
    let injected = false;
    const supabase = {
      from: (table: string) => {
        const b = base.from(table);
        if (table === "trip_members" && !injected) {
          const origUpsert = b.upsert as (payload: unknown) => unknown;
          b.upsert = (payload: unknown) => {
            injected = true;
            transactionsRows.push({
              id: "race-tx-1",
              trip_id: TRIP_ID,
              type: "expense",
              paid_by: OLD_PERSON_ID,
              credit_from: null,
              credit_to: null,
              deleted_at: null,
              confirmed_at: null,
              tranche_id: null,
              amount: 10,
              date: "2026-08-05",
            });
            return origUpsert(payload);
          };
        }
        return b;
      },
    };
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());

    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("neue Buchung");
    // Ohne den Re-Check würde das DELETE trotzdem durchlaufen — mit ihm
    // NICHT, weil die Funktion vorher abbricht.
    const memberDeletes = calls.filter((c) => c.table === "trip_members" && c.op === "delete");
    expect(memberDeletes).toHaveLength(0);
  });

  it("Idempotenz: ein Retry NACH bereits erfolgtem Umhängen dupliziert die Reassignierung nicht", async () => {
    // Simuliert den Zustand NACH einem erfolgreichen ersten Lauf, aber VOR
    // dem finalen Löschen der alten Mitgliedschaft (z.B. Absturz dazwischen):
    // die Zahlung trägt schon credit_from = NEW_PERSON_ID.
    const alreadyReassigned = { ...CONFIRMED_PAYMENT, credit_from: NEW_PERSON_ID };
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [alreadyReassigned]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    // Die Reassignierungs-Query findet keine Zeile mehr mit
    // credit_from = old_person_id → kein UPDATE, kein Doppel-Effekt.
    const updates = calls.filter((c) => c.table === "transactions" && c.op === "update");
    expect(updates).toHaveLength(0);
  });

  it("blockt den Wechsel, solange eine unbestätigte Selbstmeldung offen ist — VOR jeder Schreib-Operation", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT, PENDING_SELF_REPORT]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/unbestätigte/i);

    // Alles-oder-nichts: der Pre-Check muss vor der Personen-/Crew-Anlage
    // laufen, sonst bliebe bei einem Reject eine Ghost-Person + Creweintrag
    // als Orphan zurück (Grill-Review-Fund).
    expect(calls).toHaveLength(0);
  });

  it("lehnt eine E-Mail ab, die schon zu einem ANDEREN Crewmitglied dieses Törns gehört, statt dessen Daten zu überschreiben", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT]) as never);

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ new_email: "existing@example.com", new_display_name: "" }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/bereits.*Crewmitglied/i);

    // Insbesondere: keine neue Person angelegt, kein trip_members-Upsert,
    // die bestehende Person wurde NICHT stillschweigend übernommen.
    expect(calls.filter((c) => c.table === "persons")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "trip_members" && c.op === "upsert")).toHaveLength(0);
  });

  it("legt die neue Person mit der client-generierten ID an (upsert-by-id statt insert)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    const personsUpserts = calls.filter((c) => c.table === "persons" && c.op === "upsert");
    expect(personsUpserts).toHaveLength(1);
    expect((personsUpserts[0].payload as { id: string }).id).toBe(NEW_PERSON_ID);
  });
});
