/**
 * In-Memory-Fake für den Supabase-Query-Builder (nur Tests).
 *
 * Anders als die positionellen Skript-Mocks älterer Tests FILTERT dieser Fake
 * wirklich (`eq`/`neq`/`is`/`not … is null`/`in`/`gt`/`gte`/`or` mit
 * `col.eq.val`), persistiert Inserts/Updates/Deletes und kennt die beiden
 * DB-Garantien, auf die sich die Posten-Actions verlassen:
 *   • UNIQUE (trip_id, idempotency_key) auf `transactions` → 23505
 *   • Primärschlüssel `id` (bzw. zusammengesetzt, siehe PRIMARY_KEYS) → 23505
 * Dadurch kann ein Test prüfen, was am Ende WIRKLICH in den Tabellen steht,
 * statt nur, welche Methoden aufgerufen wurden — und ein entfernter Filter
 * (Mutation) fällt auf, weil er andere Zeilen trifft.
 *
 * Fehler-Injektion: `failOn({ table, action, nth? })` lässt die n-te passende
 * Operation mit einem Fehler scheitern.
 *
 * Eingebettete Relationen: Filter wie `transactions.trip_id` auf
 * `transaction_participants` werden über `transaction_id` aufgelöst.
 */

export type Row = Record<string, unknown>;
type Action = "select" | "insert" | "update" | "delete" | "upsert";

export interface FailRule {
  table: string;
  action: Action;
  /** 1-basiert: die wievielte passende Operation scheitert (Default 1). */
  nth?: number;
  error?: { code?: string; message: string };
}

export interface WriteLog {
  table: string;
  action: Action;
  payload?: unknown;
  filters: string[];
}

const PRIMARY_KEYS: Record<string, string[]> = {
  prepayment_item_obligations: ["item_id", "person_id"],
  transaction_participants: ["transaction_id", "person_id"],
  trip_members: ["trip_id", "person_id"],
  prepayment_obligations: ["trip_id", "person_id"],
};

export function createFakeSupabase(initial: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(initial)) tables[k] = v.map((r) => ({ ...r }));
  const writes: WriteLog[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const failRules: Array<FailRule & { seen: number }> = [];
  const rpcHandlers: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }> = {};
  let idCounter = 0;

  const t = (name: string) => (tables[name] ??= []);

  const shouldFail = (table: string, action: Action) => {
    for (const r of failRules) {
      if (r.table === table && r.action === action) {
        r.seen += 1;
        if (r.seen === (r.nth ?? 1)) return r.error ?? { message: `injected failure ${table}.${action}` };
      }
    }
    return null;
  };

  const resolveCol = (row: Row, col: string): unknown => {
    if (!col.includes(".")) return row[col];
    const [rel, field] = col.split(".");
    const fk = `${rel.replace(/s$/, "")}_id`;
    const related = t(rel).find((r) => r.id === row[fk]);
    return related ? related[field] : undefined;
  };

  function builder(table: string) {
    let action: Action = "select";
    let payload: unknown = null;
    let wantsRows = false;
    let count: string | undefined;
    let head = false;
    const preds: Array<(r: Row) => boolean> = [];
    const filterDesc: string[] = [];
    let upsertConflict: string[] | null = null;

    const b: Record<string, unknown> = {};
    const add = (desc: string, p: (r: Row) => boolean) => {
      filterDesc.push(desc);
      preds.push(p);
      return b;
    };

    b.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (action !== "select") wantsRows = true;
      count = opts?.count;
      head = !!opts?.head;
      return b;
    };
    b.insert = (p: unknown) => {
      action = "insert";
      payload = p;
      return b;
    };
    b.upsert = (p: unknown, opts?: { onConflict?: string }) => {
      action = "upsert";
      payload = p;
      upsertConflict = opts?.onConflict ? opts.onConflict.split(",") : ["id"];
      return b;
    };
    b.update = (p: unknown) => {
      action = "update";
      payload = p;
      return b;
    };
    b.delete = () => {
      action = "delete";
      return b;
    };
    b.eq = (col: string, val: unknown) => add(`${col}=${String(val)}`, (r) => resolveCol(r, col) === val);
    b.neq = (col: string, val: unknown) => add(`${col}!=${String(val)}`, (r) => resolveCol(r, col) !== val);
    b.gt = (col: string, val: number) => add(`${col}>${val}`, (r) => Number(resolveCol(r, col)) > val);
    b.gte = (col: string, val: unknown) => add(`${col}>=${String(val)}`, (r) => String(resolveCol(r, col)) >= String(val));
    b.is = (col: string, val: unknown) =>
      add(`${col} is ${String(val)}`, (r) => {
        const v = resolveCol(r, col);
        return val === null ? v === null || v === undefined : v === val;
      });
    b.not = (col: string, op: string, val: unknown) => {
      if (op === "is" && val === null) {
        return add(`${col} not null`, (r) => {
          const v = resolveCol(r, col);
          return v !== null && v !== undefined;
        });
      }
      throw new Error(`fake-supabase: not(${op}) nicht unterstützt`);
    };
    b.in = (col: string, vals: unknown[]) => add(`${col} in`, (r) => vals.includes(resolveCol(r, col)));
    b.or = (expr: string) => {
      const conds = expr.split(",").map((part) => {
        const [col, op, ...rest] = part.split(".");
        if (op !== "eq") throw new Error(`fake-supabase: or(${op}) nicht unterstützt`);
        return { col, val: rest.join(".") };
      });
      return add(`or(${expr})`, (r) => conds.some((c) => String(resolveCol(r, c.col)) === c.val));
    };
    b.order = () => b;
    b.limit = () => b;

    const matches = (r: Row) => preds.every((p) => p(r));

    const pkOf = (row: Row) => (PRIMARY_KEYS[table] ?? ["id"]).map((k) => String(row[k])).join("|");

    const exec = (): { data: unknown; error: unknown; count?: number } => {
      const injected = shouldFail(table, action);
      if (injected) return { data: null, error: injected };

      if (action === "select") {
        const rows = t(table).filter(matches).map((r) => ({ ...r }));
        if (count) return { data: head ? null : rows, error: null, count: rows.length };
        return { data: rows, error: null };
      }
      if (action === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const toInsert: Row[] = [];
        for (const raw of list) {
          const row: Row = { ...raw };
          if (!PRIMARY_KEYS[table] && row.id === undefined) row.id = `fake-${table}-${++idCounter}`;
          const existing = [...t(table), ...toInsert];
          if (existing.some((r) => pkOf(r) === pkOf(row))) {
            return { data: null, error: { code: "23505", message: `duplicate key ${table}` } };
          }
          if (
            table === "transactions" &&
            row.idempotency_key &&
            existing.some((r) => r.trip_id === row.trip_id && r.idempotency_key === row.idempotency_key)
          ) {
            return { data: null, error: { code: "23505", message: "idx_transactions_idempotency" } };
          }
          toInsert.push(row);
        }
        t(table).push(...toInsert);
        writes.push({ table, action, payload, filters: [] });
        return { data: wantsRows ? toInsert.map((r) => ({ ...r })) : null, error: null };
      }
      if (action === "upsert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        for (const raw of list) {
          const key = (r: Row) => upsertConflict!.map((k) => String(r[k])).join("|");
          const idx = t(table).findIndex((r) => key(r) === key(raw));
          if (idx >= 0) t(table)[idx] = { ...t(table)[idx], ...raw };
          else t(table).push({ ...raw });
        }
        writes.push({ table, action, payload, filters: [] });
        return { data: wantsRows ? list : null, error: null };
      }
      if (action === "update") {
        const hit = t(table).filter(matches);
        for (const r of hit) Object.assign(r, payload as Row);
        writes.push({ table, action, payload, filters: filterDesc });
        return { data: wantsRows ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      // delete
      const keep = t(table).filter((r) => !matches(r));
      const removed = t(table).length - keep.length;
      tables[table] = keep;
      writes.push({ table, action, payload: { removed }, filters: filterDesc });
      return { data: null, error: null };
    };

    b.maybeSingle = () => {
      const res = exec();
      if (res.error) return Promise.resolve(res);
      const rows = (res.data as Row[] | null) ?? [];
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    };
    b.single = () => {
      const res = exec();
      if (res.error) return Promise.resolve(res);
      const rows = (res.data as Row[] | null) ?? [];
      if (rows.length !== 1) return Promise.resolve({ data: null, error: { message: "not single" } });
      return Promise.resolve({ data: rows[0], error: null });
    };
    b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(exec()).then(onFulfilled, onRejected);
    return b;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const h = rpcHandlers[name];
      const res = h ? h(args) : { data: null, error: null };
      return Promise.resolve({ data: res.data ?? null, error: res.error ?? null });
    },
  };

  return {
    client,
    tables,
    writes,
    rpcCalls,
    failOn(rule: FailRule) {
      failRules.push({ ...rule, seen: 0 });
    },
    onRpc(name: string, handler: (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }) {
      rpcHandlers[name] = handler;
    },
    rows(table: string): Row[] {
      return t(table);
    },
  };
}
