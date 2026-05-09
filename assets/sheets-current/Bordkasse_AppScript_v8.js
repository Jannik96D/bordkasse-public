// ═══════════════════════════════════════════════════════════════════════
// BORDKASSE IJsselmeer 2026 — Apps Script v8
// 
// NEU in v8:
// - Gutschrift-Bereich wird automatisch ein-/ausgeblendet je nach Art
// - Individuell-Bereich wird automatisch ein-/ausgeblendet je nach Aufteilung
// - onEdit-Trigger reagiert live auf beide Änderungen (B6 Art, B29 Aufteilung)
// 
// INSTALLATION (einmalig):
//   1. Google Sheets öffnen → Erweiterungen → Apps Script
//   2. Vorhandenen Code markieren (Strg+A) und löschen
//   3. Diesen kompletten Code einfügen
//   4. Speichern (Strg+S)
//   5. Tabelle neu laden (F5)
// ═══════════════════════════════════════════════════════════════════════

// ── Zellpositionen (Mobile-Layout) ─────────────────────────────────────
const E = {
  TYP:         "B6",
  DATUM:       "B10",
  BESCHREIBUNG:"B13",
  KATEGORIE:   "B16",
  BEZAHLT_VON: "B19",
  BETRAG:      "B22",
  ALKOHOL:     "B25",
  AUFTEILUNG:  "B29",
  GUT_VON:     "B50",
  GUT_AN:      "B53",
  DABEI_START_ROW: 35,
  DABEI_COL:       4,
  DABEI_COUNT:     12,
  // Individuell-Block: Zeilen 32-46 (Header + Hint + Spaltenkopf + 12 Personen)
  INDIVIDUELL_FIRST_ROW: 32,
  INDIVIDUELL_LAST_ROW:  46,
  // Gutschrift-Block: Zeilen 48-54 (Header + Von + An + Hint)
  GUTSCHRIFT_FIRST_ROW:  48,
  GUTSCHRIFT_LAST_ROW:   54,
};

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
// AUTO-TRIGGER: Reagiert auf Änderungen in der Eingabe-Zelle B29 (Aufteilung)
// ════════════════════════════════════════════════════════════════════════
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== "Eingabe") return;
  
  const edited = e.range.getA1Notation();
  
  // Aufteilungs-Zelle geändert → Individuell-Block toggeln
  if (edited === E.AUFTEILUNG) {
    toggleIndividuellBlock_(sheet);
  }
  
  // Art-Zelle geändert → Gutschrift-Block toggeln
  if (edited === E.TYP) {
    toggleGutschriftBlock_(sheet);
  }
}


// ════════════════════════════════════════════════════════════════════════
// Individuell-Block ein-/ausblenden basierend auf Aufteilung
// ════════════════════════════════════════════════════════════════════════
function toggleIndividuellBlock_(wsEin) {
  const aufteilung = (wsEin.getRange(E.AUFTEILUNG).getValue() || "").toString().trim();
  const firstRow = E.INDIVIDUELL_FIRST_ROW;
  const lastRow  = E.INDIVIDUELL_LAST_ROW;
  const numRows  = lastRow - firstRow + 1;
  
  if (aufteilung === "Individuell") {
    wsEin.showRows(firstRow, numRows);
  } else {
    wsEin.hideRows(firstRow, numRows);
    // Checkboxen leeren beim Ausblenden
    for (let i = 0; i < E.DABEI_COUNT; i++) {
      wsEin.getRange(E.DABEI_START_ROW + i, E.DABEI_COL).setValue("");
    }
  }
}


// ════════════════════════════════════════════════════════════════════════
// Gutschrift-Block ein-/ausblenden basierend auf Art (Ausgabe vs Gutschrift)
// ════════════════════════════════════════════════════════════════════════
function toggleGutschriftBlock_(wsEin) {
  const typ = (wsEin.getRange(E.TYP).getValue() || "").toString().trim();
  const firstRow = E.GUTSCHRIFT_FIRST_ROW;
  const lastRow  = E.GUTSCHRIFT_LAST_ROW;
  const numRows  = lastRow - firstRow + 1;
  
  if (typ === "Gutschrift") {
    wsEin.showRows(firstRow, numRows);
  } else {
    wsEin.hideRows(firstRow, numRows);
    // Gutschrift-Felder leeren beim Ausblenden
    wsEin.getRange(E.GUT_VON).setValue("");
    wsEin.getRange(E.GUT_AN).setValue("");
  }
}


// ════════════════════════════════════════════════════════════════════════
// HAUPTFUNKTION: Transaktion speichern
// ════════════════════════════════════════════════════════════════════════
function transaktionSpeichern() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const wsEin = ss.getSheetByName("Eingabe");
  const wsTx  = ss.getSheetByName(TX.SHEET);
  const ui    = SpreadsheetApp.getUi();

  if (!wsEin || !wsTx) {
    ui.alert("❌ Fehler", "Tabellenblätter 'Eingabe' oder 'Transaktionen' nicht gefunden.", ui.ButtonSet.OK);
    return;
  }

  const typ          = (wsEin.getRange(E.TYP).getValue() || "").toString().trim();
  const datum        = wsEin.getRange(E.DATUM).getValue();
  const beschreibung = (wsEin.getRange(E.BESCHREIBUNG).getValue() || "").toString().trim();
  const kategorie    = (wsEin.getRange(E.KATEGORIE).getValue() || "").toString().trim();
  const bezahltVon   = (wsEin.getRange(E.BEZAHLT_VON).getValue() || "").toString().trim();
  const betrag       = wsEin.getRange(E.BETRAG).getValue();
  const alkohol      = wsEin.getRange(E.ALKOHOL).getValue() || 0;
  const aufteilung   = (wsEin.getRange(E.AUFTEILUNG).getValue() || "Gleichmäßig").toString().trim();
  const gutVon       = (wsEin.getRange(E.GUT_VON).getValue() || "").toString().trim();
  const gutAn        = (wsEin.getRange(E.GUT_AN).getValue() || "").toString().trim();

  const dabei = [];
  for (let i = 0; i < E.DABEI_COUNT; i++) {
    const row = E.DABEI_START_ROW + i;
    const val = (wsEin.getRange(row, E.DABEI_COL).getValue() || "").toString().trim();
    dabei.push(val);
  }

  // Validierung
  if (!typ) return alertMissing_(ui, wsEin, E.TYP, "Bitte 'Art' auswählen.");

  if (typ === "Ausgabe") {
    if (!beschreibung) return alertMissing_(ui, wsEin, E.BESCHREIBUNG, "Bitte eine Beschreibung eingeben.");
    if (!betrag || Number(betrag) === 0) return alertMissing_(ui, wsEin, E.BETRAG, "Bitte einen Betrag eingeben.");
    if (!bezahltVon) return alertMissing_(ui, wsEin, E.BEZAHLT_VON, "Bitte angeben, wer bezahlt hat.");
    if (alkohol && Number(alkohol) > Number(betrag)) {
      return alertMissing_(ui, wsEin, E.ALKOHOL, "Alkohol-Anteil darf nicht größer als der Gesamtbetrag sein.");
    }
  }

  if (typ === "Gutschrift") {
    if (!gutVon || !gutAn) return alertMissing_(ui, wsEin, E.GUT_VON, "Bitte 'Zahlt (Von)' und 'Empfängt (An)' ausfüllen.");
    if (gutVon === gutAn) {
      ui.alert("⚠️ Fehler", "'Von' und 'An' können nicht dieselbe Person sein.", ui.ButtonSet.OK);
      return;
    }
    if (!betrag || Number(betrag) === 0) return alertMissing_(ui, wsEin, E.BETRAG, "Bitte den Betrag der Gutschrift eingeben.");
  }

  // Nächste freie Zeile in Transaktionen
  const descCol = wsTx.getRange(TX.START, TX.DESC, TX.MAX - TX.START + 1, 1).getValues();
  const gutCol  = wsTx.getRange(TX.START, TX.GUT_VON, TX.MAX - TX.START + 1, 1).getValues();
  let nextRow = TX.START;
  for (let i = 0; i < descCol.length; i++) {
    if (descCol[i][0] !== "" || gutCol[i][0] !== "") {
      nextRow = TX.START + i + 1;
    }
  }

  if (nextRow > TX.MAX) {
    ui.alert("❌ Liste voll", `Max. ${TX.MAX - TX.START + 1} Einträge erreicht.`, ui.ButtonSet.OK);
    return;
  }

  let datumWert = datum;
  if (!datumWert || datumWert.toString().trim() === "") {
    datumWert = new Date();
  }

  // Schreiben
  wsTx.getRange(nextRow, TX.DATUM).setValue(datumWert).setNumberFormat("DD.MM.YYYY");
  wsTx.getRange(nextRow, TX.TYP).setValue(typ);
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

  if (typ === "Gutschrift") {
    wsTx.getRange(nextRow, TX.GUT_VON).setValue(gutVon);
    wsTx.getRange(nextRow, TX.GUT_AN).setValue(gutAn);
  }

  eingabeMaskeLeeren_(wsEin);
  schuldenBerechnen_(ss);

  const betragText = Number(betrag).toLocaleString("de-DE", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }) + " €";

  const details = typ === "Ausgabe"
    ? `Beschreibung: ${beschreibung}\nBetrag: ${betragText}\nBezahlt von: ${bezahltVon}`
    : `Von: ${gutVon} → An: ${gutAn}\nBetrag: ${betragText}`;

  ui.alert("✅ Gespeichert!", `${typ} in Zeile ${nextRow} eingetragen.\n\n${details}`, ui.ButtonSet.OK);
  wsEin.getRange(E.DATUM).activate();
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
function alertMissing_(ui, wsEin, cell, msg) {
  ui.alert("⚠️ Eingabe fehlt", msg, ui.ButtonSet.OK);
  wsEin.getRange(cell).activate();
}

function eingabeLeeren() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsEin = ss.getSheetByName("Eingabe");
  const ui = SpreadsheetApp.getUi();
  const antwort = ui.alert("Eingabe leeren?", "Alle Felder zurücksetzen?", ui.ButtonSet.YES_NO);
  if (antwort === ui.Button.YES) {
    eingabeMaskeLeeren_(wsEin);
    wsEin.getRange(E.DATUM).activate();
  }
}

function eingabeMaskeLeeren_(wsEin) {
  wsEin.getRange(E.TYP).setValue("Ausgabe");
  wsEin.getRange(E.DATUM).setValue("");
  wsEin.getRange(E.BESCHREIBUNG).setValue("");
  wsEin.getRange(E.KATEGORIE).setValue("");
  wsEin.getRange(E.BEZAHLT_VON).setValue("");
  wsEin.getRange(E.BETRAG).setValue("");
  wsEin.getRange(E.ALKOHOL).setValue("");
  wsEin.getRange(E.AUFTEILUNG).setValue("Gleichmäßig");
  wsEin.getRange(E.GUT_VON).setValue("");
  wsEin.getRange(E.GUT_AN).setValue("");
  for (let i = 0; i < E.DABEI_COUNT; i++) {
    wsEin.getRange(E.DABEI_START_ROW + i, E.DABEI_COL).setValue("");
  }
  // Nach dem Leeren: Art="Ausgabe" + Aufteilung="Gleichmäßig" → beide Blöcke ausblenden
  toggleIndividuellBlock_(wsEin);
  toggleGutschriftBlock_(wsEin);
}


// ════════════════════════════════════════════════════════════════════════
// Button-Funktionen
// ════════════════════════════════════════════════════════════════════════
function buttonSpeichern()         { transaktionSpeichern(); }
function buttonLeeren()            { eingabeLeeren(); }
function buttonSchuldenBerechnen() { schuldenBerechnen(); }


// ════════════════════════════════════════════════════════════════════════
// Menü + Initial-Zustand beim Öffnen
// ════════════════════════════════════════════════════════════════════════
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚓ Bordkasse")
    .addItem("💾 Transaktion speichern", "transaktionSpeichern")
    .addItem("🔄 Schulden neu berechnen", "schuldenBerechnen")
    .addSeparator()
    .addItem("↺ Eingabe leeren", "eingabeLeeren")
    .addToUi();
  
  // Beim Öffnen: Beide Blöcke an aktuellen Zustand anpassen
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsEin = ss.getSheetByName("Eingabe");
  if (wsEin) {
    toggleIndividuellBlock_(wsEin);
    toggleGutschriftBlock_(wsEin);
  }
}
