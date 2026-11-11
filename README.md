# Speelgoedotheek — hosten & uitrollen naar meerdere scholen

## 0. Vóór je iets host: verander de geheime sleutel
Zowel `app.js` (gebruikt door `index.html`) als `linkgenerator.html` bevatten de regel:
```
const LINK_SECRET = 'VERVANG_DIT_MET_EEN_EIGEN_GEHEIME_SLEUTEL_12345';
```
Verander deze **in beide bestanden naar dezelfde, unieke waarde** (een lange willekeurige tekst)
vóór je gaat hosten. Dit zorgt ervoor dat de app een link die via `linkgenerator.html` gemaakt is
herkent, en een manueel aangepaste of losstaand verzonnen link weigert.

**Belangrijk om te weten:** dit is een client-side controle. Omdat `app.js` publiek gehost
wordt, kan iemand met technische kennis de sleutel via "Paginabron weergeven" terugvinden en er
zelf geldige links mee genereren. Het beschermt dus wel tegen per ongeluk aangepaste/doorgestuurde
links, maar niet tegen een gerichte, technisch onderlegde poging. Voor die laatste garantie is een
server-kant validatie nodig (bv. via een gratis Cloudflare Worker) — vraag dit gerust na als dat
ooit nodig blijkt.

## 1. Eén keer hosten (gratis, via GitHub Pages)
1. Maak een gratis account op https://github.com als je er nog geen hebt.
2. Maak een nieuwe **public** repository, bv. genaamd `speelgoedotheek`.
3. Upload de bestanden `index.html`, `styles.css`, `app.js`, `manifest.json`, `icon.svg`, `sw.js` naar die repository (via "Add file" → "Upload files" in de GitHub-website, geen commandolijn nodig).
4. Ga naar **Settings → Pages** in die repository, kies bij "Source" de branch `main` en map `/ (root)`, klik Save.
5. Na een minuutje krijg je een link zoals:
   `https://<jouw-gebruikersnaam>.github.io/speelgoedotheek/`
   Dat is jullie basis-link — die verandert nooit meer, ook niet als je later de app bijwerkt.

## 2. Per school: gedeelde opslag instellen (aanbevolen als er ook tablets/Chromebooks gebruikt worden)
Werkt de school enkel met vaste Windows-PC's met OneDrive? Dan volstaat de lokale Excel-koppeling
in de app zelf (Instellingen → Excel-bestand koppelen) en kan je deze stap overslaan.
De Excel-bestandskoppeling laadt haar bibliotheek via internet en vereist daarom een internetverbinding wanneer je Excel koppelt of gebruikt. Als die bibliotheek niet beschikbaar is, meldt de app dit en schakelt ze de Excel-acties uit; de overige app-functies blijven beschikbaar.

Zijn er ook tablets/Chromebooks bij? Zet dan **per school** een gratis Google Sheets-backend op:
1. Maak een nieuw, leeg Google Sheet-document aan.
2. Extensies > Apps Script, plak de inhoud van `AppsScript-Code.gs` (zie dat bestand voor de volledige uitleg).
3. Implementeren > Nieuwe implementatie > type "Webapp" > Uitvoeren als "Ik" > Toegang "Iedereen" > Implementeren.
4. Kopieer de webapp-URL (eindigt op `/exec`) — dat vul je in bij stap 3 hieronder.

**Bestaande Apps Script-installatie veilig bijwerken:** maak eerst een kopie van het Google Sheet-document als back-up. Open daarna het bestaande Apps Script-project, vervang de code door de huidige inhoud van `AppsScript-Code.gs`, en kies **Implementeren > Implementaties beheren**. Bewerk de bestaande webapp-implementatie, kies bij Versie **Nieuwe versie**, en klik **Implementeren**. Zo blijft de bestaande `/exec`-URL behouden. Werk daarna de app bij en open/refresh de nieuwe versie op alle gebruikte computers. Oudere app-versies begrijpen het revisie- en app-versieprotocol niet en hun writes worden door de bijgewerkte backend afgewezen. De nieuwe app en backend gebruiken versienummers om te voorkomen dat een computer met verouderde gegevens de gedeelde database overschrijft. De eerste keer dat de bijgewerkte app een lege Sheet vindt, vraagt ze expliciet toestemming om die te initialiseren.

## 3. Per school een link genereren
Open `linkgenerator.html` lokaal in je browser (gewoon dubbelklikken, hoeft niet online te staan).
Vul de basis-link, de schoolnaam, de pincode en (indien van toepassing) de Apps Script-URL in →
je krijgt een kant-en-klare link, bv.:

`https://jouwnaam.github.io/speelgoedotheek/?school=GBS%20De%20Regenboog&pin=4821&sheets=https://script.google.com/macros/s/AKfyc.../exec`

Stuur die link naar de school. Bij het eerste bezoek staat **alles** meteen correct ingesteld —
naam, pincode, én de gedeelde opslag indien meegegeven — zonder dat de leerkracht iets zelf moet
configureren. Via het installatie-icoontje in Chrome/Edge kan de school de app bovendien als een
echte app "installeren".

## 4. Een bestaande installatie bijwerken
Als je later de app verbetert: upload de nieuwe bestanden gewoon opnieuw naar dezelfde GitHub-repository.
Scholen die de app als PWA geïnstalleerd hebben, krijgen de update automatisch bij hun volgende bezoek (dankzij de service worker) — niemand moet iets opnieuw downloaden of instellen.
Gebruikt de school Google Sheets, werk dan ook het Apps Script bij volgens stap 2. De computer toont een waarschuwing en pauzeert synchronisatie zolang de app en backend niet compatibel zijn. Bij gelijktijdige updates probeert de app onafhankelijke wijzigingen automatisch samen te voegen. Als twee toestellen dezelfde ontlening tegelijk als teruggegeven registreren, bewaart de app één terugkeer (met de vroegste terugtijd). Als andere gegevens conflicteren of het aantal uitgeleende stuks de voorraad overschrijdt, pauzeert synchronisatie en blijven de lokale wijzigingen bewaard; download dan een back-up voordat je de nieuwste gedeelde gegevens laadt.
Voor deze verplichte update staan `APP_VERSION` in `app.js`, `REQUIRED_APP_VERSION` in `AppsScript-Code.gs` en de cacheversie (`CACHE_NAME`) in `sw.js` op respectievelijk `1.1.0`, `1.1.0` en `speelgoedotheek-v10`. Deploy eerst een nieuwe versie van het bestaande Apps Script-webapp-project; zo worden oudere app-versies geblokkeerd voordat ze gedeelde gegevens kunnen overschrijven. Publiceer daarna de app-bestanden. Open/ververs de app op beide pc's en volg de updateprompt. De updateknop controleert op service-worker updates en herlaadt de app.
De huidige appversie is `1.2.0` (cache `speelgoedotheek-v11`). Je vindt de versie per computer in **Leerkracht → Instellingen → App-versie**. De Apps Script-backend blijft `REQUIRED_APP_VERSION = '1.1.0'`; voor deze versie met alleen een zichtbare appversie hoeft de backend niet opnieuw gedeployed te worden.
De app controleert Google Sheets elke 2 seconden zolang het venster zichtbaar is en vraagt alleen de volledige gegevens op als de revisie veranderd is. Na deze poll-optimalisatie moet ook `AppsScript-Code.gs` opnieuw als nieuwe webapp-versie worden gedeployed; gebruik bij de bestaande deployment dezelfde `REQUIRED_APP_VERSION`.

## Let op
- De linkparameters (schoolnaam/pincode/sheets-URL) zijn zichtbaar in de URL zelf — verstuur ze via een vertrouwd kanaal (bv. e-mail naar het school-domein), niet via een publiek kanaal.
- De pincode is enkel een lichte drempel tegen nieuwsgierige leerlingen, geen echte beveiliging.
- Elke school heeft een eigen Google Sheet (of eigen Excel-bestand) — er wordt niets gedeeld tussen scholen, ook niet via deze gedeelde hosting.
- De Apps Script-URL zelf is wel gevoelig: wie die URL kent, kan in principe de data van die school lezen/schrijven. Behandel hem dus als een wachtwoord — niet publiek delen.
