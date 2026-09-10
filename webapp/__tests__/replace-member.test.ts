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
  /** Törnzeitraum — Default liegt in der Zukunft (klassischer Pfad). */
  tripStart?: string;
  tripEnd?: string;
  /** Anwesenheitsfenster von A (Variante b prüft das Wechseldatum dagegen). */
  oldOnBoardFrom?: string | null;
  oldOnBoardTo?: string | null;
  /** Ist A Co-Skipper? Steuert den is_skipper-Transfer (Fund F5). */
  oldIsSkipper?: boolean;
  /**
   * Vorbelegte persons-Zeilen. Default enthält NUR old_person_id — die ID
   * der neuen Person darf noch NICHT existieren, sonst greift der
   * F1-Guard `assertFreshPersonId` (client-kontrollierte ID darf keine
   * bestehende Zeile adressieren).
   */
  extraPersons?: Array<Record<string, unknown>>;
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
    // Törnzeitraum bewusst in der Zukunft: Default dieser Tests ist der
    // klassische Wechsel VOR Törnbeginn. Variante b bekommt eigene Tests.
    trips: [
      {
        id: TRIP_ID,
        skipper_id: SKIPPER_ID,
        start_date: opts.tripStart ?? "2099-08-01",
        end_date: opts.tripEnd ?? "2099-08-10",
      },
    ],
    trip_members: [
      {
        id: OLD_MEMBER_ROW_ID,
        trip_id: TRIP_ID,
        person_id: OLD_PERSON_ID,
        on_board_from: opts.oldOnBoardFrom ?? null,
        on_board_to: opts.oldOnBoardTo ?? null,
        is_alcoholic: null,
        note: null,
        is_skipper: opts.oldIsSkipper ?? false,
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
    // NEW_PERSON_ID fehlt hier bewusst — der F1-Guard weist eine bereits
    // vergebene ID ab. Die Zeile entsteht erst durch den insert unten
    // (der Mock persistiert Inserts, damit der spätere auth_user_id-Lookup
    // für die Invite-Mail dieselbe Zeile findet wie in der echten DB).
    persons: [
      ...(opts.extraPersons ?? []),
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
    // `.gte(col, val)` — Datumsfilter des tripUnderway-Checks (Grill-Fund
    // P3: nur Bordkasse-Buchungen AB Törnbeginn zählen als „läuft schon").
    b.gte = (col: string, val: unknown) => {
      if (mode === "select") rows = rows.filter((r) => String(r[col]) >= String(val));
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
      // Inserts persistieren: sonst fände der spätere auth_user_id-Lookup
      // die eben angelegte Person nicht und der Test liefe an einem
      // anderen Zweig entlang als die echte DB.
      if (!insertError) {
        for (const row of Array.isArray(payload) ? payload : [payload]) {
          (readData[table] ??= []).push(row as Record<string, unknown>);
        }
      }
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
  return {
    from: (table: string) => make(table),
    // mark_post_settlement_change (Fund F2) — der Marker für den
    // "Bilanz hat sich geändert"-Banner nach verschickter Abrechnung.
    rpc: (fn: string, args: unknown) => {
      calls.push({ table: `rpc:${fn}`, op: "rpc", payload: args });
      return Promise.resolve({ data: null, error: null });
    },
  };
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
      // Anzahlungs-Ausgabe (A hat eine Charter-Tranche überwiesen), damit
      // dieser Test den KLASSISCHEN Pfad prüft: eine Bordkasse-Buchung
      // (tranche_id NULL) würde den Törn als "läuft bereits" markieren und
      // stattdessen ein Wechseldatum verlangen (Variante b).
      tranche_id: TRANCHE_ID,
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

  it("legt die neue Person mit der client-generierten ID an (insert-by-id)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    const personsInserts = calls.filter((c) => c.table === "persons" && c.op === "insert");
    expect(personsInserts).toHaveLength(1);
    expect((personsInserts[0].payload as { id: string }).id).toBe(NEW_PERSON_ID);
    // Fund F1: NIEMALS upsert auf persons — das war der Hebel, mit dem eine
    // untergeschobene fremde ID eine bestehende Personen-Zeile überschrieb.
    expect(calls.filter((c) => c.table === "persons" && c.op === "upsert")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "persons_private" && c.op === "upsert")).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Sanierungsrunde 2026-09 (Funde F1–F7) + Variante b (Wechsel im Törn)
// ────────────────────────────────────────────────────────────────────────

describe("replaceMember — F1: client-kontrollierte new_person_id", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedAuth.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: ACTOR_ID, display_name: "Skipper" } as never);
    mockedAuth.mockResolvedValue({ ok: true, personId: ACTOR_ID } as never);
  });

  // Kern des Fundes: `persons` ist für jeden Eingeloggten lesbar, also sind
  // alle Personen-UUIDs bekannt. Über das Hidden-Feld liess sich damit eine
  // FREMDE Personenzeile (Ghost aus einem anderen Törn) überschreiben —
  // display_name + persons_private.email — und anschliessend per
  // Ghost-Verlinkung übernehmen.
  it("weist eine bereits vergebene Personen-ID ab, ohne irgendetwas zu schreiben", async () => {
    const VICTIM_ID = "aaaaaaaa-0000-4000-8000-0000000000f1";
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [], { extraPersons: [{ id: VICTIM_ID, auth_user_id: null }] }) as never,
    );

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ new_person_id: VICTIM_ID, new_email: "angreifer@example.com" }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/ID bereits vergeben/i);
    // Nichts geschrieben — insbesondere kein Überschreiben des Opfers.
    expect(calls.filter((c) => c.op !== "rpc")).toHaveLength(0);
  });

  // F4: schlug der Crew-Lookup fehl (A parallel entfernt, veralteter Tab),
  // blieb vorher eine Personen-Zeile ohne jede Mitgliedschaft zurück, deren
  // E-Mail die UNIQUE-Constraint belegte und die Login-Whitelist passierte.
  it("legt keine Person an, wenn A gar nicht (mehr) Crew ist", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, []) as never);

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ old_person_id: OTHER_PERSON_ID, new_email: "neu@example.com" }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/nicht gefunden/i);
    expect(calls.filter((c) => c.table === "persons")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "persons_private")).toHaveLength(0);
  });

  it("weist new_person_id = old_person_id ab (Selbst-Überschreiben)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, []) as never);

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ new_person_id: OLD_PERSON_ID }),
    );

    expect(res.status).toBe("error");
    expect(calls.filter((c) => c.table === "trip_members" && c.op === "delete")).toHaveLength(0);
  });
});

describe("replaceMember — F2/F3/F5/F7: Aufräumen im klassischen Pfad", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedAuth.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: ACTOR_ID, display_name: "Skipper" } as never);
    mockedAuth.mockResolvedValue({ ok: true, personId: ACTOR_ID } as never);
  });

  it("setzt den Settlement-Marker, räumt settled_debts auf und überträgt is_skipper", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [CONFIRMED_PAYMENT], { oldIsSkipper: true }) as never,
    );

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    // F2 — ohne den Marker bliebe die Crew auf der veralteten
    // Abrechnungsmail sitzen (resendSettlement ist sonst gesperrt).
    expect(calls.some((c) => c.table === "rpc:mark_post_settlement_change")).toBe(true);
    // F3 — Häkchen einer Person, die es im Törn nicht mehr gibt.
    expect(calls.some((c) => c.table === "settled_debts" && c.op === "delete")).toBe(true);
    // F5 — Co-Skipper-Rechte müssen mitwandern, sonst steht die Crew ohne
    // handlungsfähigen Ansprechpartner da.
    const tmUpsert = calls.find((c) => c.table === "trip_members" && c.op === "upsert");
    expect((tmUpsert?.payload as { is_skipper?: boolean })?.is_skipper).toBe(true);
  });
});

describe("replaceMember — Variante b: Wechsel mitten im Törn", () => {
  // Törn läuft: Start in der Vergangenheit, Ende in der Zukunft.
  const RUNNING = { tripStart: "2020-08-01", tripEnd: "2099-08-10" };
  const HANDOVER = "2020-08-05";

  const BORDKASSE_EXPENSE_BY_OTHER = {
    id: "aaaaaaaa-0000-4000-8000-0000000000e1",
    trip_id: TRIP_ID,
    type: "expense",
    paid_by: SKIPPER_ID,
    credit_from: null,
    credit_to: null,
    tranche_id: null,
    deleted_at: null,
    confirmed_at: "2020-08-03T10:00:00Z",
    amount: 300,
    date: "2020-08-03",
  };

  // Bordkasse-Gutschrift von A — DARF in Variante b nicht auf B wandern:
  // A bleibt in der Crew, das ist weiterhin A's eigenes Geld.
  const BORDKASSE_CREDIT_BY_A = {
    id: "aaaaaaaa-0000-4000-8000-0000000000e2",
    trip_id: TRIP_ID,
    type: "credit",
    paid_by: null,
    credit_from: OLD_PERSON_ID,
    credit_to: SKIPPER_ID,
    tranche_id: null,
    deleted_at: null,
    confirmed_at: "2020-08-03T10:00:00Z",
    amount: 40,
    date: "2020-08-03",
  };

  beforeEach(() => {
    mockedPerson.mockReset();
    mockedAuth.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: ACTOR_ID, display_name: "Skipper" } as never);
    mockedAuth.mockResolvedValue({ ok: true, personId: ACTOR_ID } as never);
  });

  // Der eigentliche Geldfehler: ohne Wechseldatum würde A gelöscht und alle
  // Ausgaben VOR dem Wechsel rückwirkend auf B umverteilt (v_transaction_shares
  // leitet die Crew rein aus trip_members ab).
  it("verlangt ein Wechseldatum, sobald Bordkasse-Buchungen existieren", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [BORDKASSE_EXPENSE_BY_OTHER], RUNNING) as never,
    );

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/Wechseldatum/i);
    expect(calls.filter((c) => c.op !== "rpc")).toHaveLength(0);
  });

  it("verkürzt A statt zu löschen und setzt B ab dem Wechseltag", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [BORDKASSE_EXPENSE_BY_OTHER], RUNNING) as never,
    );

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ handover_date: HANDOVER }),
    );
    expect(res).toEqual({ status: "ok" });

    // A bleibt Crew — kein DELETE.
    expect(calls.filter((c) => c.table === "trip_members" && c.op === "delete")).toHaveLength(0);
    const shorten = calls.find((c) => c.table === "trip_members" && c.op === "update");
    expect((shorten?.payload as { on_board_to?: string })?.on_board_to).toBe(HANDOVER);

    const tmUpsert = calls.find((c) => c.table === "trip_members" && c.op === "upsert");
    const p = tmUpsert?.payload as { on_board_from?: string; on_board_to?: string; is_skipper?: boolean };
    expect(p.on_board_from).toBe(HANDOVER);
    // A's Originalwert — hier NULL („bis Törnende"), siehe Re-Grill P5.
    expect(p.on_board_to).toBeNull();
    // A behält ihre Rolle, B erbt sie nicht (A ist ja noch da).
    expect(p.is_skipper).toBe(false);
  });

  it("blockiert NICHT, wenn A schon Buchungen hat — genau dafür ist der Modus da", async () => {
    const expenseByA = { ...BORDKASSE_EXPENSE_BY_OTHER, paid_by: OLD_PERSON_ID };
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [expenseByA], RUNNING) as never);

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ handover_date: HANDOVER }),
    );
    expect(res).toEqual({ status: "ok" });
  });

  it("überträgt Anzahlungszahlungen, lässt Bordkasse-Gutschriften aber bei A", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [CONFIRMED_PAYMENT, BORDKASSE_CREDIT_BY_A], RUNNING) as never,
    );

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ handover_date: HANDOVER }),
    );
    expect(res).toEqual({ status: "ok" });

    const reassign = calls.find(
      (c) => c.table === "transactions" && c.op === "update",
    );
    const ids = (reassign?.payload as { __in?: { vals: string[] } })?.__in?.vals ?? [];
    expect(ids).toContain(CONFIRMED_PAYMENT.id);
    // Würde diese Zeile mitwandern, bekäme B eine Zahlung gutgeschrieben,
    // die B nie geleistet hat — und A verlöre ihr Guthaben.
    expect(ids).not.toContain(BORDKASSE_CREDIT_BY_A.id);
  });

  // Grill-Fund P5: der bisherige Test lief mit einem Törn, der bereits
  // BEGONNEN hatte — die Buchungs-Klausel (`txCount > 0`) war damit gar
  // nicht abgedeckt, ihr Entfernen liess den Test grün. Hier ein Törn in
  // der Zukunft MIT einer Bordkasse-Buchung ab Törnbeginn.
  it("verlangt ein Wechseldatum auch bei künftigem Törn, sobald Bordkasse-Buchungen ab Törnbeginn existieren", async () => {
    const FUTURE = { tripStart: "2099-08-01", tripEnd: "2099-08-10" };
    const bookingDuringTrip = {
      ...BORDKASSE_EXPENSE_BY_OTHER,
      date: "2099-08-02",
      confirmed_at: "2099-08-02T10:00:00Z",
    };
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [bookingDuringTrip], FUTURE) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/Wechseldatum/i);
  });

  // Gegenprobe zu P3: eine Bordkasse-Buchung VOR Törnbeginn (Versicherung,
  // Vorab-Einkauf) darf den klassischen Absage-Pfad NICHT sperren.
  it("lässt den klassischen Pfad zu, wenn die Bordkasse-Buchung vor Törnbeginn datiert ist", async () => {
    const FUTURE = { tripStart: "2099-08-01", tripEnd: "2099-08-10" };
    const insuranceBeforeTrip = {
      ...BORDKASSE_EXPENSE_BY_OTHER,
      date: "2099-06-15",
      confirmed_at: "2099-06-15T10:00:00Z",
    };
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [insuranceBeforeTrip], FUTURE) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });
    expect(calls.filter((c) => c.table === "trip_members" && c.op === "delete")).toHaveLength(1);
  });

  // P6: ohne JS schickt der Browser das Datumsfeld auch dann mit, wenn der
  // Nutzer nativ „hat abgesagt" gewählt hat — das Radio muss gewinnen.
  it("ignoriert ein mitgeschicktes Wechseldatum, wenn repl_mode=cancelled gewählt wurde", async () => {
    const FUTURE = { tripStart: "2099-08-01", tripEnd: "2099-08-10" };
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [], FUTURE) as never);

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ repl_mode: "cancelled", handover_date: "2099-08-05" }),
    );
    expect(res).toEqual({ status: "ok" });
    // Klassischer Pfad: A wird gelöscht, NICHT verkürzt.
    expect(calls.filter((c) => c.table === "trip_members" && c.op === "delete")).toHaveLength(1);
    expect(calls.filter((c) => c.table === "trip_members" && c.op === "update")).toHaveLength(0);
  });

  // P5: in Variante b darf NICHTS aufgeräumt werden — A bleibt ja Crew.
  it("räumt in Variante b weder settled_debts noch reminder_log auf und schreibt keine Audience-Zeile", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [BORDKASSE_EXPENSE_BY_OTHER], {
        ...RUNNING,
        oldIsSkipper: true,
        oldPersonRow: { id: OLD_PERSON_ID, auth_user_id: "auth-1" },
      }) as never,
    );

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ handover_date: HANDOVER }),
    );
    expect(res).toEqual({ status: "ok" });
    expect(calls.some((c) => c.table === "settled_debts")).toBe(false);
    expect(calls.some((c) => c.table === "prepayment_reminder_log")).toBe(false);
    expect(calls.some((c) => c.table === "trip_statistics_audience")).toBe(false);
    // A behält ihre Co-Skipper-Rolle (sie ist ja noch an Bord), B erbt sie nicht.
    const tmUpsert = calls.find((c) => c.table === "trip_members" && c.op === "upsert");
    expect((tmUpsert?.payload as { is_skipper?: boolean })?.is_skipper).toBe(false);
    // Der Settlement-Marker muss trotzdem gesetzt werden — die Bilanz ändert sich.
    expect(calls.some((c) => c.table === "rpc:mark_post_settlement_change")).toBe(true);
  });

  // P7: on_board_from darf NICHT materialisiert werden, sonst folgt A als
  // einziges Mitglied einer späteren Törnstart-Verschiebung nicht mehr.
  it("lässt on_board_from von A unangetastet", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [BORDKASSE_EXPENSE_BY_OTHER], RUNNING) as never,
    );

    await replaceMember({ status: "idle" }, replaceFormData({ handover_date: HANDOVER }));
    const shorten = calls.find((c) => c.table === "trip_members" && c.op === "update");
    expect(Object.keys(shorten?.payload as object)).toEqual(["on_board_to"]);
  });

  // Re-Grill P6: die `todayIso >= start_date`-Klausel war nicht abgedeckt —
  // der bestehende Test hatte IMMER auch eine Buchung. Hier: laufender Törn,
  // NULL Buchungen. Ohne die Klausel dürfte der Klassiker mitten im Törn
  // löschen.
  it("verlangt ein Wechseldatum bei laufendem Törn auch ganz ohne Buchungen", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [], RUNNING) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/Wechseldatum/i);
    expect(calls.filter((c) => c.op !== "rpc")).toHaveLength(0);
  });

  // Re-Grill P4: Gegenstück zum repl_mode-Vorrang. „handover" ohne Datum
  // fiel vorher still in den Lösch-Pfad — das exakte Gegenteil der Wahl.
  it("lehnt repl_mode=handover ohne Wechseltag ab, statt A zu löschen", async () => {
    const FUTURE = { tripStart: "2099-08-01", tripEnd: "2099-08-10" };
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [], FUTURE) as never);

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ repl_mode: "handover", handover_date: "" }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/Wechseltag/i);
    expect(calls.filter((c) => c.table === "trip_members" && c.op === "delete")).toHaveLength(0);
  });

  // Re-Grill P5: war A's on_board_to NULL („bis Törnende"), muss auch B NULL
  // bekommen — sonst folgt B einer späteren Törnverlängerung nicht mehr.
  it("materialisiert das offene Törnende der neuen Person nicht", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [BORDKASSE_EXPENSE_BY_OTHER], RUNNING) as never,
    );

    await replaceMember({ status: "idle" }, replaceFormData({ handover_date: HANDOVER }));
    const tmUpsert = calls.find((c) => c.table === "trip_members" && c.op === "upsert");
    expect((tmUpsert?.payload as { on_board_to?: string | null })?.on_board_to).toBeNull();
  });

  it("weist ein Wechseldatum ausserhalb des Törnzeitraums ab", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [BORDKASSE_EXPENSE_BY_OTHER], RUNNING) as never,
    );

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ handover_date: "2019-01-01" }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/Törnzeitraum/i);
    expect(calls.filter((c) => c.op !== "rpc")).toHaveLength(0);
  });

  it("weist ein Wechseldatum ausserhalb von A's Anwesenheit ab", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [BORDKASSE_EXPENSE_BY_OTHER], {
        ...RUNNING,
        oldOnBoardFrom: "2020-08-06",
        oldOnBoardTo: "2099-08-10",
      }) as never,
    );

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ handover_date: HANDOVER }), // vor A's Ankunft
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/Anwesenheitszeitraum/i);
  });
});
