/**
 * Speelgoedotheek — Apps Script backend
 *
 * INSTALLATIE (eenmalig, per school, ±5 minuten):
 * 1. Maak een nieuw, leeg Google Sheet-document aan (sheets.google.com).
 * 2. Ga naar Extensies > Apps Script.
 * 3. Verwijder de voorbeeldcode en plak deze volledige inhoud erin.
 * 4. Klik op "Implementeren" (Deploy) > "Nieuwe implementatie" (New deployment).
 * 5. Kies als type: "Webapp" (Web app).
 * 6. "Uitvoeren als": Ik (Me).
 * 7. "Wie heeft toegang": Iedereen (Anyone).
 * 8. Klik Implementeren, geef toestemming, en kopieer de webapp-URL
 *    (eindigt op /exec) — dat is de "Apps Script Web App-URL" die je
 *    in de app onder Instellingen invult, of meegeeft aan de linkgenerator.
 *
 * Nadien blijft de data leesbaar/aanpasbaar in dit Google Sheet zelf,
 * op de tabbladen "Leerlingen", "Speelgoed" en "Geschiedenis". Het
 * tabblad "_data" bevat de technische opslag en revisie — niet manueel aanpassen.
 * Bij updates: bewerk de bestaande webapp-implementatie en publiceer een nieuwe versie,
 * zodat de bestaande /exec-URL behouden blijft.
 * Verhoog REQUIRED_APP_VERSION wanneer een nieuwe app-versie verplicht moet worden.
 */

var REQUIRED_APP_VERSION = '1.1.0';

function doGet(e) {
  var stored = readStoredData_();
  var response = {
    protocol: 1,
    requiredAppVersion: REQUIRED_APP_VERSION,
    revision: stored.revision,
    empty: stored.empty
  };
  var since = e && e.parameter ? Number(e.parameter.since) : NaN;
  if (!stored.empty && Number.isInteger(since) && since === stored.revision) {
    response.unchanged = true;
  } else {
    response.unchanged = false;
    response.state = stored.state;
  }
  return jsonOutput_(response);
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput_({ ok: false, error: 'invalid_json' });
  }

  if (!payload || !Number.isInteger(payload.expectedRevision) ||
      !isValidAppVersion_(payload.appVersion) || !isValidState_(payload.state)) {
    return jsonOutput_({ ok: false, error: 'invalid_request' });
  }
  if (compareVersions_(payload.appVersion, REQUIRED_APP_VERSION) < 0) {
    return jsonOutput_({
      ok: false,
      updateRequired: true,
      requiredAppVersion: REQUIRED_APP_VERSION
    });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var stored = readStoredData_();
    if (!stored.empty && !isValidState_(stored.state)) {
      return jsonOutput_({ ok: false, error: 'stored_data_invalid' });
    }
    if (payload.expectedRevision !== stored.revision) {
      return jsonOutput_({ ok: false, conflict: true, revision: stored.revision });
    }

    var nextRevision = stored.revision + 1;
    getDataSheet_().getRange('A1').setValue(JSON.stringify({
      protocol: 1,
      revision: nextRevision,
      state: payload.state
    }));

    var viewsUpdated = true;
    try {
      updateReadableSheets_(payload.state);
    } catch (err) {
      viewsUpdated = false;
      console.error('De gegevens zijn opgeslagen, maar de leesbare tabbladen konden niet worden bijgewerkt.', err);
    }
    return jsonOutput_({ ok: true, revision: nextRevision, viewsUpdated: viewsUpdated });
  } finally {
    lock.releaseLock();
  }
}

function getDataSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('_data');
  if (!sheet) {
    sheet = ss.insertSheet('_data');
    sheet.hideSheet();
    sheet.getRange('A1').setValue('{}');
  }
  return sheet;
}

function readStoredData_() {
  var raw = getDataSheet_().getRange('A1').getValue();
  if (!raw) return { state: null, revision: 0, empty: true };

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: null, revision: 0, empty: false };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { state: parsed, revision: 0, empty: false };
  }

  if (parsed && parsed.protocol === 1 && Number.isInteger(parsed.revision)) {
    return {
      state: parsed.state,
      revision: parsed.revision,
      empty: false
    };
  }

  if (Object.keys(parsed).length === 0) {
    return { state: null, revision: 0, empty: true };
  }

  return {
    state: parsed,
    revision: 1,
    empty: false
  };
}

function isValidState_(state) {
  return state && Array.isArray(state.students) &&
    Array.isArray(state.toys) && Array.isArray(state.loans);
}

function isValidAppVersion_(version) {
  return typeof version === 'string' && /^\d+(\.\d+)*$/.test(version);
}

function compareVersions_(left, right) {
  var a = left.split('.').map(Number);
  var b = right.split('.').map(Number);
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    var difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function updateReadableSheets_(state) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  writeSheet_(ss, 'Leerlingen', ['Naam', 'Leerjaar', 'Klasgroep', '6de leerjaar', 'Status', 'Opmerking'],
    (state.students || []).map(function (s) {
      return [s.naam, s.leerjaar || '', s.klasgroep || '', s.kanBeheerder ? 'Ja' : 'Nee', s.actief === false ? 'Inactief' : 'Actief', s.opmerking || ''];
    }));

  var loanedCount = {};
  (state.loans || []).forEach(function (l) {
    if (!l.teruggegeven) loanedCount[l.toyId] = (loanedCount[l.toyId] || 0) + 1;
  });
  writeSheet_(ss, 'Speelgoed', ['Naam', 'Categorie', 'Aantal', 'Beschikbaar'],
    (state.toys || []).map(function (t) {
      var aantal = t.aantal || 1;
      var beschikbaar = Math.max(0, aantal - (loanedCount[t.id] || 0));
      return [t.naam, t.categorie || '', aantal, beschikbaar];
    }));

  var toyName = {};
  (state.toys || []).forEach(function (t) { toyName[t.id] = t.naam; });
  var studentName = {};
  (state.students || []).forEach(function (s) { studentName[s.id] = s.naam; });
  function namesFor(idsOrId) {
    if (!idsOrId) return '';
    var ids = Array.isArray(idsOrId) ? idsOrId : [idsOrId];
    return ids.map(function (id) { return studentName[id] || '?'; }).join(', ');
  }

  writeSheet_(ss, 'Geschiedenis', ['Speelgoed', 'Leerling', 'Uitgeleend door', 'Uitgeleend op', 'Status'],
    (state.loans || []).slice().reverse().map(function (l) {
      return [
        toyName[l.toyId] || '?',
        studentName[l.studentId] || '?',
        namesFor(l.beheerderIdUit),
        l.uitDatum || '',
        l.teruggegeven ? ('Terug op ' + l.terugDatum) : 'Nog buiten'
      ];
    }));
}

function writeSheet_(ss, name, headers, rows) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
}
