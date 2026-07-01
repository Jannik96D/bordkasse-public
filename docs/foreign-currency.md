# Fremdwährungen — Bordkasse Web-App

> Buchungen in einer anderen Währung als Euro (z. B. Restaurant in NOK, Hafen in DKK).
> Migration `0041_foreign_currency`. Ergänzt den Betragsfeld-Rechner (PR #192).

## Grundprinzip

**Euro ist und bleibt die einzige Bilanz-Wahrheit.** `transactions.amount` (und
`transaction_participants.amount`) speichern immer den Euro-Wert; alle Views
(`v_balances`, `v_transaction_shares`, …) rechnen ausschließlich damit und sind
**unverändert**. Die Fremdwährung ist reine Eingabe- + Anzeigeschicht: Man gibt
den Fremdbetrag ein (wie auf dem Bon), der Server rechnet ihn zum Kurs in Euro um
und legt die Herkunft als „Bon-Spur" ab.

## Opt-in pro Törn

Standardmäßig ist ein Törn reiner Euro-Törn — es erscheint **keine** Währungs-UI.
Erst wenn der Skipper in den Törneinstellungen Währungen freischaltet
(`settings/currency-section.tsx` → `updateTripCurrencies` in
`lib/actions/trips.ts`, Spalte `trips.foreign_currencies TEXT[]`), zeigt die
Buchungsmaske einen Währungswähler. So bleibt die App für den 90-%-Fall clean.

Kuratierte 21-Währungs-Liste in `lib/rates/currencies.ts` (DKK, SEK, NOK, GBP,
CHF, PLN, BGN, ISK, TRY, ALL, USD, CAD, MXN, THB, XCD, BBD, BSD, DOP, MUR, SCR,
XPF) — alle vom Kurs-Anbieter abgedeckt. Nur Skipper/Admin darf freischalten.

## Kurs (Variante B — live je Buchung)

- **Online:** `lib/rates/get-rate.ts:getLiveRates` zieht **server-seitig** einen
  `open.er-api.com/v6/latest/EUR`-Call (kostenlos, kein API-Key) und invertiert
  zu „EUR pro 1 Einheit Fremdwährung". Server-seitig, weil die Produktions-CSP
  (`connect-src`) einen Client-Fetch nach außen blockt. `getCurrencyOptions`
  (`lib/rates/currency-options.ts`) reicht den Default-Kurs an die Buchungsseite
  (`new` + `edit` + DraftEditor).
- **Offline:** greift der Kurs der letzten Buchung derselben Währung (aus
  `transactions.exchange_rate`). Zusätzlich cacht das Formular online geladene
  Kurse persistent in localStorage (`lib/offline/rate-cache.ts`), damit auch die
  **erste** Offline-Buchung einer Währung einen Kurs hat.
- **Fallback-Kette** bei Währungswahl: Server-Default (live / letzte Buchung) →
  localStorage-Cache → leer (manuelle Eingabe).
- Der Kurs ist im Formular **immer editierbar** (`CurrencyField` in
  `transaction-form-parts.tsx`); Kurs-Quelle `live` / `manual` / `bank`.

## Umrechnung (serverseitig, EUR-Wahrheit)

Bei einer Fremdwährungs-Buchung tragen die eingegebenen Beträge (amount,
alcohol_amount, tip_amount, Pro-Person-Beträge) den **Fremdbetrag**. Der Server
rechnet zentral in Euro um — reine, unit-getestete Funktionen in
`lib/rates/resolve.ts` (`resolveExpenseCurrency` / `resolveCreditCurrency`, NICHT
in der `"use server"`-Datei, wo nur async-Exports erlaubt sind), Umrechnung via
`foreignToEur` (`lib/rates/convert.ts`). Abgelegt werden:

| Spalte | Bedeutung |
|---|---|
| `transactions.amount` | EUR-Wert (Bilanz) |
| `original_currency` | ISO-Code, `NULL` = EUR nativ |
| `original_amount` | Fremdbetrag (Bon) |
| `exchange_rate` | 1 Einheit Fremd = X EUR (`amount = original_amount × rate`) |
| `rate_source` | `live` \| `manual` \| `bank` |
| `rate_confirmed_at` | gesetzt, sobald der Bankkurs nachgetragen wurde |
| `transaction_participants.original_amount` | Fremdbetrag je Person (Pro Person) |

Die Buchungsliste zeigt den Originalbetrag als kleine Zeile unter dem
€-Betrag (z. B. „500,00 SEK").

## Pro Person + Fremdwährung

Jede Person trägt ihren Fremdbetrag vom Bon ein; `transaction_participants.
original_amount` = Fremd, `amount` = EUR (Fremd × Buchungskurs). Der Buchungs-
Gesamtbetrag ist die Summe der gerundeten Personen-EUR (`Σ participants ==
amount`, Bilanz summiert zu null).

## Tatsächlicher Bankkurs nachtragen (Paket F)

Der Online-/Tageskurs ist eine Schätzung; die Bank bucht zu ihrem echten Kurs
inkl. Gebühren/Spread ab. Im Bank-Block der Buchung (Aufklapper „Echten
Bankbetrag nachtragen") trägt man später den **abgebuchten Euro-Betrag laut
Kontoauszug** ein → der Server leitet den effektiven Kurs ab, setzt
`rate_source='bank'` + `rate_confirmed_at`, und die Bilanz nutzt den echten Wert.

**Divisor = voller Fremdbetrag der Kartenzahlung** (`bank_foreign_amount`,
optionales Zweitfeld): nötig, wenn im Betrag etwas rausgerechnet wurde (z. B. ein
Privatkauf via Betragsrechner). Dann bucht die Karte den ganzen Bon ab, die
Buchung enthält aber nur den geteilten Teil — der Server rechnet
`abgebuchter Euro ÷ voller Fremdbetrag` und wendet den Kurs auf den geteilten
Buchungsbetrag an. Leer → Divisor = Buchungsbetrag.

```
Bon 480 NOK, davon 80 privat → geteilt 400 NOK. Bank bucht 480 NOK = 41,50 € ab.
  effektiver Kurs = 41,50 / 480 = 0,086458
  geteilter EUR-Betrag = 400 × 0,086458 = 34,58 €   (NICHT 41,50 €)
```

`bank_foreign_amount` ist transient (keine DB-Spalte). Client-Spiegel
`computeEffRate` in `transaction-form.tsx` == `effectiveRate` in `resolve.ts`.
Bei Pro Person wird der effektive Kurs auf alle Anteile angewandt.

## Betragsfeld-Rechner (PR #192)

Alle Betragsfelder (Ausgabe, Gutschrift, Alkohol, Trinkgeld, Pro Person)
akzeptieren Rechen-Ausdrücke, z. B. `47,30 - 6,00` (Privatkäufe rausrechnen) oder
`240,00 / 4`. Ausgewertet via `safeMathEval` (`lib/utils/math-eval.ts`,
CSP-sicherer Parser, **kein** `eval`); `onBlur` schreibt das Ergebnis formatiert
zurück, der Zod-Preprocessor `evalExpr` wertet serverseitig als Netz aus.

## Tests

`webapp/__tests__/currency.test.ts` (Umrechnung/Rundung, Live-Kurs-Abruf,
Bank-Override inkl. Privatabzug, Schema, `withBookingCurrency`),
`webapp/__tests__/rate-cache.test.ts` (Offline-Cache). Views bleiben unberührt →
kein neuer pgTAP-Test nötig.

## Bewusste Grenzen

- **Alkohol/Trinkgeld** können beim Bearbeiten einer Fremdwährungsbuchung um
  ±1 Cent driften (nur diese zwei Felder werden aus EUR zurückgerechnet; der
  Betrag selbst ist exakt über `original_amount`). Verletzt den
  `alcohol_amount ≤ amount`-CHECK nicht (Rundung monoton).
- **MAX_AMOUNT (1 Mio)** gilt bei Fremdwährung in Fremdeinheiten (Plausibilitäts-Guard).
- **XPF** ist fest an den Euro gekoppelt (1 € = 119,3317 XPF); der Anbieter
  liefert den Kurs trotzdem live mit.
- **Kein neues Env** — open.er-api.com braucht keinen Key.
