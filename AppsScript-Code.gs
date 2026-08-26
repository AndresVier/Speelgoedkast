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
 * tabblad "_data" bevat de technische kopie — niet manueel aanpassen.
 */

function doGet(e) {
  var sheet = getDataSheet_();
  var json = sheet.getRange('A1').getValue() || '{}';
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var sheet = getDataSheet_();
  var body = e.postData ? e.postData.contents : '{}';
  sheet.getRange('A1').setValue(body);
  try {
    updateReadableSheets_(JSON.parse(body));
  } catch (err) {
    // leesbare tabbladen zijn een bonus; als dit faalt blijft de technische data toch correct opgeslagen
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
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
