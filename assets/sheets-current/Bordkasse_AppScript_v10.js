// ═══════════════════════════════════════════════════════════════════════
// BORDKASSE IJsselmeer 2026 — Apps Script v10
//
// NEU in v10:
// - Anwesenheits-Checkbox jetzt in Spalte C (vorher D)
// - Leere Crew-Slots werden im Individuell-Block automatisch ausgeblendet
//   und eingeblendet, sobald Namen in Besatzung B11:B22 ergänzt werden
//
// INSTALLATION (einmalig):
//   1. Google Sheets öffnen → Erweiterungen → Apps Script
//   2. Vorhandenen Code markieren (Strg+A) und löschen
//   3. Diesen kompletten Code einfügen
//   4. Speichern (Strg+S)
//   5. Tabelle neu laden (F5)
// ═══════════════════════════════════════════════════════════════════════

// ── Eingabe (Ausgaben) ─────────────────────────────────────────────────
const E = {
  SHEET:        "Eingabe",
  DATUM:        "B6",
  BESCHREIBUNG: "B9",
  KATEGORIE:    "B12",
  BEZAHLT_VON:  "B15",
  BETRAG:       "B18",
  ALKOHOL:      "B21",
  AUFTEILUNG:   "B25",
  DABEI_START_ROW: 31,
  DABEI_COL:       3,    // Spalte C (war D in v9)
  DABEI_COUNT:     12,
  INDIVIDUELL_FIRST_ROW: 28,
  INDIVIDUELL_LAST_ROW:  42,
};

// ── Gutschrift (eigener Tab) ───────────────────────────────────────────
const G = {
  SHEET:        "Gutschrift",
  DATUM:        "B6",
  BESCHREIBUNG: "B9",
  BETRAG:       "B12",
  GUT_VON:      "B16",
  GUT_AN:       "B19",
};

// ── Transaktionen ──────────────────────────────────────────────────────
const TX = {
  SHEET:    "Transaktionen",
  START:    4,
  MAX:      203,
  DATUM:    2,  TYP: 3,  DESC: 4,  KAT: 5,
  PAID:     6,  BETRAG: 7,  ALKOHOL: 8,  SPLIT: 9,
  DABEI_S:  10,
  GUT_VON:  34,
  GUT_AN:   35,
};

const B = {
  SHEET:      "Besatzung",
  NAME_COL:   2,
  NAME_START: 11,
  N:          12,
};

const S = {
  SHEET:      "Schulden",
  DATA_START: 8,
  DATA_MAX:   27,
  TIMESTAMP:  31,
};


// ════════════════════════════════════════════════════════════════════════
// AUTO-TRIGGER
// - Eingabe B25 (Aufteilung) → Individuell-Block toggeln
// - Besatzung B11:B22 (Namen) → leere Crew-Zeilen aktualisieren
// ════════════════════════════════════════════════════════════════════════
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (sheetName === E.SHEET) {
    if (e.range.getA1Notation() === E.AUFTEILUNG) {
      toggleIndividuellBlock_(sheet);
    }
    return;
  }

  if (sheetName === B.SHEET) {
    // Edit überschneidet Namen-Spalte in Crew-Bereich?
    const minRow = e.range.getRow();
    const maxRow = minRow + e.range.getNumRows() - 1;
    const minCol = e.range.getColumn();
    const maxCol = minCol + e.range.getNumColumns() - 1;

    const overlapsNameCol = (minCol <= B.NAME_COL && maxCol >= B.NAME_COL);
    const overlapsCrew    = (maxRow >= B.NAME_START && minRow < B.NAME_START + B.N);

    if (overlapsNameCol && overlapsCrew) {
      const wsEin = ss.getSheetByName(E.SHEET);
      if (!wsEin) return;
      const aufteilung = (wsEin.getRange(E.AUFTEILUNG).getValue() || "").toString().trim();
      if (aufteilung === "Individuell") {
        refreshDabeiZeilen_(wsEin, sheet);
      }
    }
  }
}


// ════════════════════════════════════════════════════════════════════════
// Individuell-Block ein-/ausblenden + leere Crew-Zeilen aktualisieren
// ════════════════════════════════════════════════════════════════════════
function toggleIndividuellBlock_(wsEin) {
  const aufteilung = (wsEin.getRange(E.AUFTEILUNG).getValue() || "").toString().trim();
  const firstRow = E.INDIVIDUELL_FIRST_ROW;
  const numRows  = E.INDIVIDUELL_LAST_ROW - firstRow + 1;

  if (aufteilung === "Individuell") {
    wsEin.showRows(firstRow, numRows);
    const wsBes = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(B.SHEET);
    refreshDabeiZeilen_(wsEin, wsBes);
  } else {
    wsEin.hideRows(firstRow, numRows);
    for (let i = 0; i < E.DABEI_COUNT; i++) {
      wsEin.getRange(E.DABEI_START_ROW + i, E.DABEI_COL).setValue("");
    }
  }
}


function refreshDabeiZeilen_(wsEin, wsBes) {
  // Im sichtbaren Individuell-Block: Crew-Zeilen ohne Namen ausblenden,
  // mit Namen einblenden. Voraussetzung: Block ist gerade aufgeklappt.
  if (!wsEin || !wsBes) return;
  for (let i = 0; i < E.DABEI_COUNT; i++) {
    const name = wsBes.getRange(B.NAME_START + i, B.NAME_COL).getValue();
    const row  = E.DABEI_START_ROW + i;
    if (!name || name.toString().trim() === "") {
      wsEin.hideRows(row);
      // Sicherheitshalber Checkbox einer leer-gewordenen Zeile zurücksetzen
      wsEin.getRange(row, E.DABEI_COL).setValue("");
    } else {
      wsEin.showRows(row);
    }
  }
}


// ════════════════════════════════════════════════════════════════════════
// AUSGABE SPEICHERN (Eingabe-Tab)
// ════════════════════════════════════════════════════════════════════════
function transaktionSpeichern() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const wsEin = ss.getSheetByName(E.SHEET);
  const wsTx  = ss.getSheetByName(TX.SHEET);
  const ui    = SpreadsheetApp.getUi();

  if (!wsEin || !wsTx) {
    ui.alert("❌ Fehler", "Tabellenblätter 'Eingabe' oder 'Transaktionen' nicht gefunden.", ui.ButtonSet.OK);
    return;
  }

  const datum        = wsEin.getRange(E.DATUM).getValue();
  const beschreibung = (wsEin.getRange(E.BESCHREIBUNG).getValue() || "").toString().trim();
  const kategorie    = (wsEin.getRange(E.KATEGORIE).getValue() || "").toString().trim();
  const bezahltVon   = (wsEin.getRange(E.BEZAHLT_VON).getValue() || "").toString().trim();
  const betrag       = wsEin.getRange(E.BETRAG).getValue();
  const alkohol      = wsEin.getRange(E.ALKOHOL).getValue() || 0;
  const aufteilung   = (wsEin.getRange(E.AUFTEILUNG).getValue() || "Gleichmäßig").toString().trim();

  const dabei = [];
  for (let i = 0; i < E.DABEI_COUNT; i++) {
    const row = E.DABEI_START_ROW + i;
    const val = (wsEin.getRange(row, E.DABEI_COL).getValue() || "").toString().trim();
    dabei.push(val);
  }

  if (!beschreibung) return alertMissing_(ui, wsEin, E.BESCHREIBUNG, "Bitte eine Beschreibung eingeben.");
  if (!betrag || Number(betrag) === 0) return alertMissing_(ui, wsEin, E.BETRAG, "Bitte einen Betrag eingeben.");
  if (!bezahltVon) return alertMissing_(ui, wsEin, E.BEZAHLT_VON, "Bitte angeben, wer bezahlt hat.");
  if (alkohol && Number(alkohol) > Number(betrag)) {
    return alertMissing_(ui, wsEin, E.ALKOHOL, "Alkohol-Anteil darf nicht größer als der Gesamtbetrag sein.");
  }

  const nextRow = freieZeileFinden_(wsTx);
  if (nextRow === -1) {
    ui.alert("❌ Liste voll", `Max. ${TX.MAX - TX.START + 1} Einträge erreicht.`, ui.ButtonSet.OK);
    return;
  }

  let datumWert = (datum && datum.toString().trim() !== "") ? datum : new Date();

  wsTx.getRange(nextRow, TX.DATUM).setValue(datumWert).setNumberFormat("DD.MM.YYYY");
  wsTx.getRange(nextRow, TX.TYP).setValue("Ausgabe");
  wsTx.getRange(nextRow, TX.DESC).setValue(beschreibung);
  wsTx.getRange(nextRow, TX.KAT).setValue(kategorie);
  wsTx.getRange(nextRow, TX.PAID).setValue(bezahltVon);
  wsTx.getRange(nextRow, TX.BETRAG).setValue(betrag).setNumberFormat('#,##0.00 "€"');

  if (alkohol && Number(alkohol) > 0) {
    wsTx.getRange(nextRow, TX.ALKOHOL).setValue(alkohol).setNumberFormat('#,##0.00 "€"');
  }

  wsTx.getRange(nextRow, TX.SPLIT).setValue(aufteilung);

  if (aufteilung === "Individuell") {
    for (let p = 0; p < B.N; p++) {
      if (dabei[p] && dabei[p].toLowerCase() === "x") {
        wsTx.getRange(nextRow, TX.DABEI_S + p).setValue("x");
      }
    }
  }

  eingabeMaskeLeeren_(wsEin);
  schuldenBerechnen_(ss);

  const betragText = Number(betrag).toLocaleString("de-DE", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }) + " €";

  ui.alert("✅ Gespeichert!",
    `Ausgabe in Zeile ${nextRow} eingetragen.\n\n` +
    `Beschreibung: ${beschreibung}\nBetrag: ${betragText}\nBezahlt von: ${bezahltVon}`,
    ui.ButtonSet.OK);
  wsEin.getRange(E.DATUM).activate();
}


// ════════════════════════════════════════════════════════════════════════
// GUTSCHRIFT SPEICHERN (eigener Tab)
// ════════════════════════════════════════════════════════════════════════
function gutschriftSpeichern() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const wsGut = ss.getSheetByName(G.SHEET);
  const wsTx  = ss.getSheetByName(TX.SHEET);
  const ui    = SpreadsheetApp.getUi();

  if (!wsGut || !wsTx) {
    ui.alert("❌ Fehler", "Tabellenblätter 'Gutschrift' oder 'Transaktionen' nicht gefunden.", ui.ButtonSet.OK);
    return;
  }

  const datum        = wsGut.getRange(G.DATUM).getValue();
  const beschreibung = (wsGut.getRange(G.BESCHREIBUNG).getValue() || "").toString().trim();
  const betrag       = wsGut.getRange(G.BETRAG).getValue();
  const gutVon       = (wsGut.getRange(G.GUT_VON).getValue() || "").toString().trim();
  const gutAn        = (wsGut.getRange(G.GUT_AN).getValue() || "").toString().trim();

  if (!gutVon || !gutAn) return alertMissing_(ui, wsGut, G.GUT_VON, "Bitte 'Zahlt (Von)' und 'Empfängt (An)' ausfüllen.");
  if (gutVon === gutAn) {
    ui.alert("⚠️ Fehler", "'Von' und 'An' können nicht dieselbe Person sein.", ui.ButtonSet.OK);
    return;
  }
  if (!betrag || Number(betrag) === 0) return alertMissing_(ui, wsGut, G.BETRAG, "Bitte den Betrag der Gutschrift eingeben.");

  const nextRow = freieZeileFinden_(wsTx);
  if (nextRow === -1) {
    ui.alert("❌ Liste voll", `Max. ${TX.MAX - TX.START + 1} Einträge erreicht.`, ui.ButtonSet.OK);
    return;
  }

  let datumWert = (datum && datum.toString().trim() !== "") ? datum : new Date();

  wsTx.getRange(nextRow, TX.DATUM).setValue(datumWert).setNumberFormat("DD.MM.YYYY");
  wsTx.getRange(nextRow, TX.TYP).setValue("Gutschrift");
  wsTx.getRange(nextRow, TX.DESC).setValue(beschreibung || "Gutschrift");
  wsTx.getRange(nextRow, TX.BETRAG).setValue(betrag).setNumberFormat('#,##0.00 "€"');
  wsTx.getRange(nextRow, TX.GUT_VON).setValue(gutVon);
  wsTx.getRange(nextRow, TX.GUT_AN).setValue(gutAn);

  gutschriftMaskeLeeren_(wsGut);
  schuldenBerechnen_(ss);

  const betragText = Number(betrag).toLocaleString("de-DE", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }) + " €";

  ui.alert("✅ Gespeichert!",
    `Gutschrift in Zeile ${nextRow} eingetragen.\n\n` +
    `Von: ${gutVon} → An: ${gutAn}\nBetrag: ${betragText}`,
    ui.ButtonSet.OK);
  wsGut.getRange(G.DATUM).activate();
}


// ════════════════════════════════════════════════════════════════════════
// SCHULDEN-ALGORITHMUS
// ════════════════════════════════════════════════════════════════════════
function schuldenBerechnen() {
  schuldenBerechnen_(SpreadsheetApp.getActiveSpreadsheet());
  SpreadsheetApp.getUi().alert(
    "✅ Neu berechnet",
    "Das Schulden-Sheet wurde aktualisiert.",
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function schuldenBerechnen_(ss) {
  const wsBal = ss.getSheetByName("Bilanz");
  const wsSch = ss.getSheetByName(S.SHEET);
  if (!wsBal || !wsSch) return;

  const data = wsBal.getRange(4, 1, 12, 6).getValues();
  const personen = [];
  for (const row of data) {
    const name = row[0];
    const saldo = Number(row[5]) || 0;
    if (name && typeof name === "string" && name.trim() !== "" && name !== "—") {
      personen.push({ name: name.trim(), saldo: Math.round(saldo * 100) / 100 });
    }
  }

  const schuldner = personen
    .filter(p => p.saldo < -0.005)
    .map(p => ({ name: p.name, offen: -p.saldo }))
    .sort((a, b) => b.offen - a.offen);
  const glaeubiger = personen
    .filter(p => p.saldo > 0.005)
    .map(p => ({ name: p.name, offen: p.saldo }))
    .sort((a, b) => b.offen - a.offen);

  const transaktionen = [];
  let si = 0, gi = 0;
  while (si < schuldner.length && gi < glaeubiger.length) {
    const s = schuldner[si];
    const g = glaeubiger[gi];
    const betrag = Math.round(Math.min(s.offen, g.offen) * 100) / 100;
    if (betrag > 0) transaktionen.push({ von: s.name, an: g.name, betrag });
    s.offen -= betrag;
    g.offen -= betrag;
    if (s.offen < 0.005) si++;
    if (g.offen < 0.005) gi++;
  }

  wsSch.getRange(S.DATA_START, 1, S.DATA_MAX - S.DATA_START + 1, 5).clearContent();
  for (let i = 0; i < transaktionen.length && i < 20; i++) {
    const r = S.DATA_START + i;
    const t = transaktionen[i];
    wsSch.getRange(r, 1).setValue(t.von);
    wsSch.getRange(r, 2).setValue(t.an);
    wsSch.getRange(r, 3).setValue(t.betrag).setNumberFormat('#,##0.00 "€"');
    wsSch.getRange(r, 4).setValue("☐");
  }

  const now = new Date();
  const dateStr = Utilities.formatDate(now, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm");
  wsSch.getRange(S.TIMESTAMP, 1).setValue(dateStr + "  (" + transaktionen.length + " Überweisungen)");
}


// ════════════════════════════════════════════════════════════════════════
// Hilfsfunktionen
// ════════════════════════════════════════════════════════════════════════
function freieZeileFinden_(wsTx) {
  const descCol = wsTx.getRange(TX.START, TX.DESC,    TX.MAX - TX.START + 1, 1).getValues();
  const gutCol  = wsTx.getRange(TX.START, TX.GUT_VON, TX.MAX - TX.START + 1, 1).getValues();
  let nextRow = TX.START;
  for (let i = 0; i < descCol.length; i++) {
    if (descCol[i][0] !== "" || gutCol[i][0] !== "") {
      nextRow = TX.START + i + 1;
    }
  }
  return nextRow > TX.MAX ? -1 : nextRow;
}

function alertMissing_(ui, ws, cell, msg) {
  ui.alert("⚠️ Eingabe fehlt", msg, ui.ButtonSet.OK);
  ws.getRange(cell).activate();
}

function eingabeLeeren() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsEin = ss.getSheetByName(E.SHEET);
  const ui = SpreadsheetApp.getUi();
  const antwort = ui.alert("Eingabe leeren?", "Alle Felder zurücksetzen?", ui.ButtonSet.YES_NO);
  if (antwort === ui.Button.YES) {
    eingabeMaskeLeeren_(wsEin);
    wsEin.getRange(E.DATUM).activate();
  }
}

function gutschriftLeeren() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsGut = ss.getSheetByName(G.SHEET);
  const ui = SpreadsheetApp.getUi();
  const antwort = ui.alert("Gutschrift leeren?", "Alle Felder zurücksetzen?", ui.ButtonSet.YES_NO);
  if (antwort === ui.Button.YES) {
    gutschriftMaskeLeeren_(wsGut);
    wsGut.getRange(G.DATUM).activate();
  }
}

function eingabeMaskeLeeren_(wsEin) {
  wsEin.getRange(E.DATUM).setValue(new Date()).setNumberFormat("DD.MM.YYYY");
  wsEin.getRange(E.BESCHREIBUNG).setValue("");
  wsEin.getRange(E.KATEGORIE).setValue("");
  wsEin.getRange(E.BEZAHLT_VON).setValue("");
  wsEin.getRange(E.BETRAG).setValue("");
  wsEin.getRange(E.ALKOHOL).setValue("");
  wsEin.getRange(E.AUFTEILUNG).setValue("Gleichmäßig");
  for (let i = 0; i < E.DABEI_COUNT; i++) {
    wsEin.getRange(E.DABEI_START_ROW + i, E.DABEI_COL).setValue("");
  }
  toggleIndividuellBlock_(wsEin);
}

function gutschriftMaskeLeeren_(wsGut) {
  wsGut.getRange(G.DATUM).setValue(new Date()).setNumberFormat("DD.MM.YYYY");
  wsGut.getRange(G.BESCHREIBUNG).setValue("");
  wsGut.getRange(G.BETRAG).setValue("");
  wsGut.getRange(G.GUT_VON).setValue("");
  wsGut.getRange(G.GUT_AN).setValue("");
}


// ════════════════════════════════════════════════════════════════════════
// Button-Wrapper
// ════════════════════════════════════════════════════════════════════════
function buttonSpeichern()           { transaktionSpeichern(); }
function buttonGutschriftSpeichern() { gutschriftSpeichern(); }
function buttonLeeren()              { eingabeLeeren(); }
function buttonGutschriftLeeren()    { gutschriftLeeren(); }
function buttonSchuldenBerechnen()   { schuldenBerechnen(); }


// ════════════════════════════════════════════════════════════════════════
// Menü + Initial-Zustand beim Öffnen
// ════════════════════════════════════════════════════════════════════════
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚓ Bordkasse")
    .addItem("💾 Ausgabe speichern",      "transaktionSpeichern")
    .addItem("💾 Gutschrift speichern",   "gutschriftSpeichern")
    .addSeparator()
    .addItem("🔄 Schulden neu berechnen", "schuldenBerechnen")
    .addSeparator()
    .addItem("↺ Eingabe leeren",          "eingabeLeeren")
    .addItem("↺ Gutschrift leeren",       "gutschriftLeeren")
    .addToUi();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsEin = ss.getSheetByName(E.SHEET);
  const wsGut = ss.getSheetByName(G.SHEET);

  if (wsEin) {
    toggleIndividuellBlock_(wsEin);  // ruft refreshDabeiZeilen_ wenn Individuell aktiv
    if (!wsEin.getRange(E.DATUM).getValue()) {
      wsEin.getRange(E.DATUM).setValue(new Date()).setNumberFormat("DD.MM.YYYY");
    }
  }
  if (wsGut && !wsGut.getRange(G.DATUM).getValue()) {
    wsGut.getRange(G.DATUM).setValue(new Date()).setNumberFormat("DD.MM.YYYY");
  }
}
