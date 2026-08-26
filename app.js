
(function(){
  "use strict";

  /* ============================================================================
   * SPEELGOEDOTHEEK — app.js
   *
   * Inhoud:
   *   1. State & configuratie
   *   2. Lokale opslag (localStorage)
   *   3. Algemene hulpfuncties (formattering, DOM, tekst)
   *   4. Back-up (handmatig exporteren/importeren)
   *   5. Gedeelde opslag — Google Sheets (optioneel, multi-toestel)
   *   6. Gedeelde opslag — lokaal Excel-bestand (optioneel, Chrome/Edge)
   *   7. Live verversen (multi-toestel polling, ~6s)
   *   8. Whitelabel: configuratie via ondertekende link
   *   9. Routing
   *  10. Onboarding-schermen & topbar
   *  11. Hoofdschermen (start, kast-beheerder, overzicht)
   *  12. Leerkracht-beheer (leerlingen, speelgoed, geschiedenis, statistieken, instellingen)
   *  13. Opstart
   * ============================================================================ */

  // ==========================================================================
  // 1. STATE & CONFIGURATIE
  // ==========================================================================
  const DEFAULT_CONFIG = { pin: "1234", schoolNaam: "", ingesteld: false, sheetsUrl: "" };
  let state = {
    config: DEFAULT_CONFIG,
    students: [],       // {id, naam, klas, kanBeheerder}
    toys: [],           // {id, naam, status}
    activeBeheerders: [], // array of student ids, kast open when length>0
    loans: []           // {id, toyId, studentId, beheerderIdUit, uitDatum, teruggegeven, beheerderIdTerug, terugDatum}
  };
  let route = "home";
  let adminUnlocked = false;
  let pendingBeheerderSelection = [];
  let leerlingenZoek = '';
  let speelgoedZoek = '';
  const OVERDUE_MS = 24 * 60 * 60 * 1000; // langer dan 1 dag uitgeleend = "te lang uitgeleend"
  function isOverdue(loan){ return !loan.teruggegeven && (Date.now() - new Date(loan.uitDatum).getTime()) > OVERDUE_MS; }
  function toyLoanedCount(toyId){ return state.loans.filter(l=>l.toyId===toyId && !l.teruggegeven).length; }
  function toyAvailableCount(toy){ return Math.max(0, (toy.aantal||1) - toyLoanedCount(toy.id)); }
  function beheerderNames(idsOrId){
    if(!idsOrId) return '';
    const ids = Array.isArray(idsOrId) ? idsOrId : [idsOrId];
    return ids.map(studentName).join(', ');
  }

  function loadAll(){
    state = {
      config: getData('config', DEFAULT_CONFIG),
      students: getData('students', []),
      toys: getData('toys', []),
      activeBeheerders: getData('activeBeheerders', []),
      loans: getData('loans', [])
    };
  }

  // ==========================================================================
  // 2. LOKALE OPSLAG (localStorage)
  // ==========================================================================
  const STORAGE_PREFIX = 'speelgoedotheek:';
  function getData(key, fallback){
    try{
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw ? JSON.parse(raw) : fallback;
    }catch(e){ return fallback; }
  }
  function setData(key, value){
    try{ localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); }
    catch(e){ console.error('storage set failed', key, e); toast('Opslaan mislukt — is de browseropslag vol of uitgeschakeld?'); }
    scheduleFileSync();
    scheduleCloudSync();
  }
  function uid(){ return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random())); }

  // ==========================================================================
  // 3. ALGEMENE HULPFUNCTIES (formattering, DOM, tekst)
  // ==========================================================================
  function toast(msg){
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(()=>el.remove(), 2200);
  }

  function studentName(id){
    const s = state.students.find(x=>x.id===id);
    return s ? s.naam : '(onbekend)';
  }
  function fmtDate(iso){
    const d = new Date(iso);
    return d.toLocaleDateString('nl-BE', {day:'2-digit', month:'2-digit'}) + ' ' + d.toLocaleTimeString('nl-BE', {hour:'2-digit', minute:'2-digit'});
  }

  function el(tag, cls, html){
    const e = document.createElement(tag);
    if(cls) e.className = cls;
    if(html!==undefined) e.innerHTML = html;
    return e;
  }

  // ==========================================================================
  // 4. BACK-UP (handmatig exporteren/importeren als bestand)
  // ==========================================================================
  function exportBackup(){
    const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'speelgoedotheek-backup-' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }
  function importBackup(file){
    const reader = new FileReader();
    reader.onload = ()=>{
      try{
        const data = JSON.parse(reader.result);
        if(!data.students || !data.toys) throw new Error('ongeldig bestand');
        state = { config: data.config || DEFAULT_CONFIG, students: data.students||[], toys: data.toys||[], activeBeheerders: data.activeBeheerders||[], loans: data.loans||[] };
        setData('config', state.config); setData('students', state.students); setData('toys', state.toys);
        setData('activeBeheerders', state.activeBeheerders); setData('loans', state.loans);
        toast('Back-up geladen.');
        route = 'home';
        render();
      }catch(e){ toast('Kon dit bestand niet lezen — is het een geldige back-up?'); }
    };
    reader.readAsText(file);
  }

  // ==========================================================================
  // 5. GEDEELDE OPSLAG — GOOGLE SHEETS (optioneel, multi-toestel)
  // ==========================================================================
  let cloudSyncTimer = null;
  let cloudSyncing = false;
  function scheduleCloudSync(){
    if(!state.config.sheetsUrl) return;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(()=>{ pushToSheets(state.config.sheetsUrl); }, 600);
  }
  async function pushToSheets(url){
    try{
      cloudSyncing = true;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // vermijdt een CORS-preflight richting Apps Script
        body: JSON.stringify(state)
      });
    }catch(e){ console.error('kon niet synchroniseren met Google Sheets', e); }
    finally{ cloudSyncing = false; }
  }
  async function fetchFromSheets(url){
    const res = await fetch(url, { method:'GET' });
    if(!res.ok) throw new Error('serverfout bij ophalen (' + res.status + ')');
    const json = await res.json();
    if(!json || typeof json !== 'object') throw new Error('ongeldig antwoord');
    return json;
  }

  async function connectSheets(url){
    url = url.trim();
    if(!url){ toast('Geef een geldige Apps Script-URL in.'); return; }
    try{
      const remote = await fetchFromSheets(url);
      // een gloednieuw, nog leeg Sheet-document geeft {} terug — dan vertrekken we van de huidige lokale data
      const looksEmpty = !remote.students && !remote.toys && !remote.loans;
      if(!looksEmpty){
        state = { config: {...state.config, ...(remote.config||{}), sheetsUrl: url}, students: remote.students||[], toys: remote.toys||[], activeBeheerders: remote.activeBeheerders||[], loans: remote.loans||[] };
      } else {
        state.config.sheetsUrl = url;
      }
      setData('config', state.config); setData('students', state.students); setData('toys', state.toys);
      setData('activeBeheerders', state.activeBeheerders); setData('loans', state.loans);
      await pushToSheets(url);
      toast('Verbonden met Google Sheets.');
      render();
      startPolling();
    }catch(e){ toast('Kon geen verbinding maken: ' + e.message); }
  }
  function disconnectSheets(){
    state.config.sheetsUrl = '';
    setData('config', state.config);
    toast('Google Sheets-koppeling verwijderd — data blijft lokaal bewaard.');
    render();
    startPolling();
  }

  // ==========================================================================
  // 6. GEDEELDE OPSLAG — LOKAAL EXCEL-BESTAND (optioneel, Chrome/Edge)
  // ==========================================================================
  const FS_SUPPORTED = ('showSaveFilePicker' in window) && ('showOpenFilePicker' in window);
  let fileHandle = null;
  let fileHandlePermGranted = false;
  let fileSyncTimer = null;
  function fileHandleConnected(){ return !!(fileHandle && fileHandlePermGranted); }

  function idbOpen(){
    return new Promise((resolve,reject)=>{
      const req = indexedDB.open('speelgoedotheek-db', 1);
      req.onupgradeneeded = ()=>{ req.result.createObjectStore('handles'); };
      req.onsuccess = ()=>resolve(req.result);
      req.onerror = ()=>reject(req.error);
    });
  }
  async function idbSetHandle(handle){
    const db = await idbOpen();
    return new Promise((resolve,reject)=>{
      const tx = db.transaction('handles','readwrite');
      tx.objectStore('handles').put(handle, 'dataFile');
      tx.oncomplete = ()=>resolve();
      tx.onerror = ()=>reject(tx.error);
    });
  }
  async function idbGetHandle(){
    const db = await idbOpen();
    return new Promise((resolve,reject)=>{
      const tx = db.transaction('handles','readonly');
      const req = tx.objectStore('handles').get('dataFile');
      req.onsuccess = ()=>resolve(req.result||null);
      req.onerror = ()=>reject(req.error);
    });
  }
  async function idbClearHandle(){
    const db = await idbOpen();
    return new Promise((resolve,reject)=>{
      const tx = db.transaction('handles','readwrite');
      tx.objectStore('handles').delete('dataFile');
      tx.oncomplete = ()=>resolve();
      tx.onerror = ()=>reject(tx.error);
    });
  }

  function buildWorkbook(){
    const wb = XLSX.utils.book_new();
    const leerlingenRows = state.students.map(s=>({
      Naam:s.naam, Leerjaar: s.leerjaar||'', Klasgroep: s.klasgroep||'',
      '6de leerjaar': s.kanBeheerder?'Ja':'Nee', Status: s.actief===false?'Inactief':'Actief', Opmerking: s.opmerking||''
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(leerlingenRows), 'Leerlingen');

    const speelgoedRows = state.toys.map(t=>({
      Naam:t.naam, Categorie: t.categorie||'',
      Aantal: t.aantal||1, Beschikbaar: toyAvailableCount(t)
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(speelgoedRows), 'Speelgoed');

    const ontleningenRows = state.loans.slice().sort((a,b)=>new Date(b.uitDatum)-new Date(a.uitDatum)).map(l=>{
      const toy = state.toys.find(t=>t.id===l.toyId);
      return {
        Speelgoed: toy?toy.naam:'(verwijderd)', Leerling: studentName(l.studentId),
        'Uitgeleend door': beheerderNames(l.beheerderIdUit), 'Uitgeleend op': fmtDate(l.uitDatum),
        Status: l.teruggegeven ? ('Terug op '+fmtDate(l.terugDatum)+' (via '+beheerderNames(l.beheerderIdTerug)+')') : 'Nog buiten'
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ontleningenRows), 'Geschiedenis');

    const dataSheet = XLSX.utils.aoa_to_sheet([['Niet bewerken — technische data'], [JSON.stringify(state)]]);
    XLSX.utils.book_append_sheet(wb, dataSheet, '_data');
    return wb;
  }

  async function writeToFile(){
    if(!fileHandle) return;
    try{
      const perm = await fileHandle.requestPermission({mode:'readwrite'});
      if(perm !== 'granted') return;
      const wb = buildWorkbook();
      const arr = XLSX.write(wb, {bookType:'xlsx', type:'array'});
      const writable = await fileHandle.createWritable();
      await writable.write(arr);
      await writable.close();
    }catch(e){ console.error('kon niet wegschrijven naar bestand', e); }
  }
  function scheduleFileSync(){
    if(!fileHandle) return;
    clearTimeout(fileSyncTimer);
    fileSyncTimer = setTimeout(()=>{ writeToFile(); }, 500);
  }
  async function loadFromFile(handle){
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const dataSheet = wb.Sheets['_data'];
    if(!dataSheet) throw new Error('geen geldig Speelgoedotheek-bestand');
    const rows = XLSX.utils.sheet_to_json(dataSheet, {header:1});
    const json = rows[1] && rows[1][0];
    if(!json) throw new Error('geen geldig Speelgoedotheek-bestand');
    const parsed = JSON.parse(json);
    state = { config: parsed.config||DEFAULT_CONFIG, students: parsed.students||[], toys: parsed.toys||[], activeBeheerders: parsed.activeBeheerders||[], loans: parsed.loans||[] };
    setData('config', state.config); setData('students', state.students); setData('toys', state.toys);
    setData('activeBeheerders', state.activeBeheerders); setData('loans', state.loans);
  }

  async function linkNewFile(){
    try{
      const handle = await window.showSaveFilePicker({
        suggestedName: (state.config.schoolNaam||'speelgoedotheek') + '-data.xlsx',
        types: [{ description:'Excel-bestand', accept: {'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']} }]
      });
      await idbSetHandle(handle);
      fileHandle = handle;
      fileHandlePermGranted = true;
      await writeToFile();
      toast('Gekoppeld aan ' + handle.name + '. Bewaar dit bestand in je OneDrive-map voor automatische back-up.');
      render();
      startPolling();
    }catch(e){ if(e.name!=='AbortError') toast('Kon geen bestand aanmaken: ' + e.message); }
  }
  async function linkExistingFile(){
    try{
      const [handle] = await window.showOpenFilePicker({
        types: [{ description:'Excel-bestand', accept: {'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']} }]
      });
      const perm = await handle.requestPermission({mode:'readwrite'});
      if(perm !== 'granted'){ toast('Toestemming geweigerd.'); return; }
      await idbSetHandle(handle);
      fileHandle = handle;
      fileHandlePermGranted = true;
      await loadFromFile(handle);
      toast('Gegevens geladen uit ' + handle.name);
      render();
      startPolling();
    }catch(e){ if(e.name!=='AbortError') toast('Kon dit bestand niet koppelen: ' + e.message); }
  }
  async function unlinkFile(){
    await idbClearHandle();
    fileHandle = null;
    fileHandlePermGranted = false;
    toast('Bestandskoppeling verwijderd — data blijft wel lokaal bewaard.');
    render();
    startPolling();
  }
  async function tryReconnectOnStartup(){
    if(!FS_SUPPORTED) return;
    try{
      const handle = await idbGetHandle();
      if(!handle) return;
      const perm = await handle.queryPermission({mode:'readwrite'});
      if(perm === 'granted'){
        fileHandle = handle;
        fileHandlePermGranted = true;
        await loadFromFile(handle);
      } else {
        fileHandle = handle; // known, but needs a click to reconnect (handled in Instellingen)
        fileHandlePermGranted = false;
      }
    }catch(e){ console.error('reconnect mislukt', e); }
  }

  // ==========================================================================
  // 7. LIVE VERVERSEN (multi-toestel polling, ~6s)
  // ==========================================================================
  let pollTimer = null;
  function snapshotKey(){
    return JSON.stringify({ students: state.students, toys: state.toys, loans: state.loans, activeBeheerders: state.activeBeheerders });
  }
  function startPolling(){
    if(pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if(!state.config.ingesteld) return;
    if(!state.config.sheetsUrl && !fileHandleConnected()) return;
    pollTimer = setInterval(async ()=>{
      // niet verversen terwijl iemand middenin een invoerveld typt, dat zou het overschrijven
      const active = document.activeElement;
      if(active && (active.tagName==='INPUT' || active.tagName==='TEXTAREA')) return;
      const before = snapshotKey();
      try{
        if(state.config.sheetsUrl){
          const remote = await fetchFromSheets(state.config.sheetsUrl);
          if(remote && (remote.students || remote.toys || remote.loans || remote.activeBeheerders)){
            state.students = remote.students||[]; state.toys = remote.toys||[];
            state.loans = remote.loans||[]; state.activeBeheerders = remote.activeBeheerders||[];
          }
        } else if(fileHandleConnected()){
          await loadFromFile(fileHandle);
        }
      }catch(e){ /* stil falen — volgende poging over 6s, laatst gekende stand blijft zichtbaar */ return; }
      if(snapshotKey() !== before){
        if(state.config.sheetsUrl){
          setData('students', state.students); setData('toys', state.toys);
          setData('loans', state.loans); setData('activeBeheerders', state.activeBeheerders);
        }
        render();
      }
    }, 6000);
  }

  // ==========================================================================
  // 8. WHITELABEL: CONFIGURATIE VIA ONDERTEKENDE LINK
  // ==========================================================================
  // LET OP: verander deze sleutel voor jullie eigen uitrol (moet identiek zijn aan die in linkgenerator.html).
  // Dit is een client-side controle die per-ongeluk-aangepaste of los-verzonnen links tegenhoudt — het is
  // GEEN waterdichte beveiliging, want deze sleutel staat mee in de publiek gehoste broncode (zie "Paginabron
  // weergeven"). Voor echte bescherming is een server-kant validatie nodig (optie B, later).
  const LINK_SECRET = 'VERVANG_DIT_MET_EEN_EIGEN_GEHEIME_SLEUTEL_12345';

  async function hmacSign(secret, message){
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return Array.from(new Uint8Array(sigBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  let pendingUrlConfig = null;
  let linkConfigInvalid = false;
  async function applyUrlConfig(){
    if(state.config.ingesteld) return; // bestaande, al-geconfigureerde installatie nooit overschrijven
    const params = new URLSearchParams(window.location.search);
    const school = (params.get('school') || '').trim();
    const pin = (params.get('pin') || '').trim();
    const sheets = (params.get('sheets') || '').trim();
    const sig = params.get('sig');
    if(!school && !pin && !sheets) return; // geen linkconfiguratie aanwezig, gewoon de normale wizard tonen

    if(!sig){
      linkConfigInvalid = true;
      return;
    }
    const expected = await hmacSign(LINK_SECRET, school + '|' + pin + '|' + sheets);
    if(expected !== sig){
      linkConfigInvalid = true;
      return;
    }
    pendingUrlConfig = {
      schoolNaam: school || 'Onze school',
      pin: pin || '1234',
      sheetsUrl: sheets
    };
  }

  // ==========================================================================
  // 9. ROUTING
  // ==========================================================================
  function go(r){ route = r; render(); }

  function render(){
    const app = document.getElementById('app');
    app.innerHTML = '';
    if(!state.config.ingesteld){
      if(linkConfigInvalid) app.appendChild(viewInvalidLink());
      else app.appendChild(pendingUrlConfig ? viewConfirmUrlConfig() : viewSetup());
      return;
    }
    app.appendChild(topbar());
    let body;
    if(route === 'home') body = viewHome();
    else if(route === 'beheerder') body = viewBeheerder();
    else if(route === 'overzicht') body = viewOverzicht();
    else if(route === 'admin') body = viewAdmin();
    app.appendChild(body);
  }

  // ==========================================================================
  // 10. ONBOARDING-SCHERMEN & TOPBAR
  // ==========================================================================
  function viewInvalidLink(){
    const wrap = el('div');
    const card = el('div','card lockscreen');
    card.style.maxWidth = '420px';
    card.appendChild(el('div','icon','⚠️'));
    card.appendChild(el('h1','page-title','Ongeldige link'));
    card.appendChild(el('p','muted','Deze installatielink is aangepast, onvolledig, of niet afkomstig van de officiële linkgenerator. De instellingen erin worden daarom niet automatisch toegepast.'));
    const btn = document.createElement('button');
    btn.className = 'primary'; btn.style.width = '100%'; btn.style.marginTop = '10px';
    btn.textContent = 'Toch handmatig instellen';
    btn.onclick = ()=>{
      linkConfigInvalid = false;
      history.replaceState(null, '', window.location.pathname + window.location.hash);
      render();
    };
    card.appendChild(btn);
    wrap.appendChild(card);
    return wrap;
  }

  function viewConfirmUrlConfig(){
    const wrap = el('div');
    const card = el('div','card lockscreen');
    card.style.maxWidth = '420px';
    card.appendChild(el('div','icon','🔗'));
    card.appendChild(el('h1','page-title','Instellen via link'));
    card.appendChild(el('p','muted','Deze link wil dit toestel automatisch instellen met onderstaande gegevens. Controleer of dit klopt vooraleer je bevestigt.'));
    const box = el('div','card');
    box.style.background = 'var(--paper)';
    box.style.textAlign = 'left';
    box.innerHTML = '<b>Schoolnaam:</b> ' + pendingUrlConfig.schoolNaam + '<br>'
      + '<b>Pincode:</b> ' + pendingUrlConfig.pin + '<br>'
      + '<b>Gedeelde opslag:</b> ' + (pendingUrlConfig.sheetsUrl ? ('gekoppeld — ' + pendingUrlConfig.sheetsUrl) : 'niet gekoppeld, enkel lokaal op dit toestel');
    card.appendChild(box);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'primary'; confirmBtn.style.width = '100%'; confirmBtn.style.marginTop = '14px';
    confirmBtn.textContent = 'Klopt, bevestigen en starten';
    confirmBtn.onclick = async ()=>{
      state.config = { pin: pendingUrlConfig.pin, schoolNaam: pendingUrlConfig.schoolNaam, sheetsUrl: pendingUrlConfig.sheetsUrl, ingesteld: true };
      setData('config', state.config);
      history.replaceState(null, '', window.location.pathname + window.location.hash);
      if(state.config.sheetsUrl){
        try{
          const remote = await fetchFromSheets(state.config.sheetsUrl);
          if(remote && (remote.students || remote.toys || remote.loans)){
            state = { ...state, students: remote.students||[], toys: remote.toys||[], activeBeheerders: remote.activeBeheerders||[], loans: remote.loans||[] };
            setData('students', state.students); setData('toys', state.toys);
            setData('activeBeheerders', state.activeBeheerders); setData('loans', state.loans);
          }
        }catch(e){ console.error('kon niet laden van Google Sheets', e); }
      }
      pendingUrlConfig = null;
      toast('Welkom, ' + state.config.schoolNaam + '!');
      render();
      startPolling();
    };
    card.appendChild(confirmBtn);

    const manualBtn = document.createElement('button');
    manualBtn.className = 'secondary'; manualBtn.style.width = '100%'; manualBtn.style.marginTop = '8px';
    manualBtn.textContent = 'Dit klopt niet — handmatig instellen';
    manualBtn.onclick = ()=>{
      pendingUrlConfig = null;
      history.replaceState(null, '', window.location.pathname + window.location.hash);
      render();
    };
    card.appendChild(manualBtn);
    wrap.appendChild(card);
    return wrap;
  }

  function viewSetup(){
    const wrap = el('div');
    const card = el('div','card lockscreen');
    card.style.maxWidth = '380px';
    card.appendChild(el('div','icon','📦'));
    card.appendChild(el('h1','page-title','Welkom!'));
    card.appendChild(el('p','muted','Dit is de eerste keer dat de Speelgoedotheek op dit toestel opstart. Vul kort wat gegevens in — dit hoeft maar één keer per school/toestel.'));
    card.appendChild(el('label','field','Naam van de school'));
    const naamInput = document.createElement('input'); naamInput.type='text'; naamInput.placeholder='bv. GBS De Regenboog';
    naamInput.style.marginBottom='12px';
    card.appendChild(naamInput);
    card.appendChild(el('label','field','Pincode voor de leerkracht (admin)'));
    const pinInput = document.createElement('input'); pinInput.type='text'; pinInput.placeholder='bv. 1234'; pinInput.value='1234';
    pinInput.style.marginBottom='16px';
    card.appendChild(pinInput);
    const startBtn = document.createElement('button');
    startBtn.className='primary'; startBtn.style.width='100%'; startBtn.textContent='Starten';
    startBtn.onclick = ()=>{
      state.config = { pin: pinInput.value.trim()||'1234', schoolNaam: naamInput.value.trim()||'Onze school', ingesteld: true };
      setData('config', state.config);
      toast('Welkom, ' + state.config.schoolNaam + '!');
      render();
    };
    card.appendChild(startBtn);
    card.appendChild(el('p','footer-note','Alle gegevens blijven enkel op dit toestel opgeslagen — er wordt niets online verstuurd.'));
    wrap.appendChild(card);
    return wrap;
  }

  function topbar(){
    const bar = document.createElement('div');
    bar.className = 'topbar';
    const brandLabel = '<span class="crate"></span> Speelgoedotheek' + (state.config.schoolNaam ? ' <span class="badge" style="vertical-align:middle;">'+state.config.schoolNaam+'</span>' : '');
    const brand = el('div', 'brand', brandLabel);
    brand.onclick = ()=>go('home');
    const nav = document.createElement('nav');
    nav.className = 'crumbs';
    [['home','🏠 Start'],['beheerder','🔑 Kast'],['overzicht','📦 Overzicht'],['admin','🔒 Leerkracht']].forEach(([r,label])=>{
      const b = document.createElement('button');
      b.textContent = label;
      if(route===r) b.classList.add('active');
      b.onclick = ()=>go(r);
      nav.appendChild(b);
    });
    bar.appendChild(brand); bar.appendChild(nav);
    return bar;
  }

  // ==========================================================================
  // 11. HOOFDSCHERMEN (start, kast-beheerder, overzicht)
  // ==========================================================================
  function viewHome(){
    const wrap = el('div');
    wrap.appendChild(el('h1','page-title','Onze speelgoedkast'));
    const kastOpen = state.activeBeheerders.length > 0;
    const tiles = el('div','tiles');

    const t1 = el('div','tile');
    t1.innerHTML = '<div class="icon">🔑</div><h3>Kast openen</h3><p>Voor het 6de leerjaar: geef aan wie beheerder is en beheer het uitlenen &amp; teruggeven.</p>'
      + (kastOpen ? '<span class="badge">KAST OPEN</span>' : '');
    t1.onclick = ()=>go('beheerder');

    const t2 = el('div','tile');
    t2.innerHTML = '<div class="icon">📦</div><h3>Overzicht</h3><p>Bekijk welk speelgoed beschikbaar is en wie wat ontleend heeft.</p>';
    t2.onclick = ()=>go('overzicht');

    const t3 = el('div','tile');
    t3.innerHTML = '<div class="icon">🔒</div><h3>Leerkracht</h3><p>Leerlingen en speelgoed beheren, geschiedenis bekijken.</p>';
    t3.onclick = ()=>go('admin');

    tiles.appendChild(t1); tiles.appendChild(t2); tiles.appendChild(t3);
    wrap.appendChild(tiles);
    wrap.appendChild(el('div','footer-note','Alle data blijft lokaal op dit toestel — gebruik best voornamen om iedereens privacy te beschermen.'));
    return wrap;
  }

  function viewBeheerder(){
    const wrap = el('div');
    wrap.appendChild(el('h1','page-title','Kast beheren'));

    if(state.activeBeheerders.length === 0){
      // selection screen
      const card = el('div','card');
      card.appendChild(el('h2','Wie is er nu beheerder?'));
      card.appendChild(el('p','muted','Kies één of meerdere leerlingen van het 6de leerjaar die nu de kast openhouden.'));
      const beheerderKandidaten = state.students.filter(s=>s.kanBeheerder && s.actief!==false);
      if(beheerderKandidaten.length===0){
        card.appendChild(el('div','empty','Er zijn nog geen leerlingen gemarkeerd als "6de leerjaar". Vraag de leerkracht dit in te stellen.'));
      } else {
        const list = el('div','pill-list');
        beheerderKandidaten.forEach(s=>{
          const p = el('label','pill'+(pendingBeheerderSelection.includes(s.id)?' selected':''), '☑ '+s.naam);
          p.onclick = (e)=>{
            e.preventDefault();
            const idx = pendingBeheerderSelection.indexOf(s.id);
            if(idx>=0) pendingBeheerderSelection.splice(idx,1); else pendingBeheerderSelection.push(s.id);
            render();
          };
          list.appendChild(p);
        });
        card.appendChild(list);
        const btn = document.createElement('button');
        btn.className = 'primary';
        btn.style.marginTop = '16px';
        btn.textContent = 'Kast openen';
        btn.disabled = pendingBeheerderSelection.length===0;
        btn.onclick = async ()=>{
          state.activeBeheerders = pendingBeheerderSelection.slice();
          pendingBeheerderSelection = [];
          await setData('activeBeheerders', state.activeBeheerders);
          toast('Kast is open!');
          render();
        };
        card.appendChild(btn);
      }
      wrap.appendChild(card);
      return wrap;
    }

    // kast is open
    const banner = el('div','banner');
    banner.innerHTML = '<span>🔓 Kast open — beheerder(s): ' + state.activeBeheerders.map(studentName).join(', ') + '</span>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'secondary';
    closeBtn.textContent = 'Kast sluiten';
    closeBtn.onclick = ()=>{
      const openCount = state.loans.filter(l=>!l.teruggegeven).length;
      if(openCount > 0 && !confirm('Er staat nog ' + openCount + ' stuk(s) speelgoed open. Toch de kast sluiten?')){
        return;
      }
      state.activeBeheerders = [];
      setData('activeBeheerders', []);
      toast('Kast gesloten.');
      render();
    };
    banner.appendChild(closeBtn);
    wrap.appendChild(banner);

    // uitlenen
    const uitleenCard = el('div','card');
    uitleenCard.appendChild(el('h2','🧸 Speelgoed uitlenen'));
    const beschikbaar = state.toys.filter(t=>toyAvailableCount(t) > 0);
    if(beschikbaar.length===0){
      uitleenCard.appendChild(el('div','empty','Al het speelgoed is momenteel ontleend.'));
    } else if(state.students.filter(s=>s.actief!==false).length===0){
      uitleenCard.appendChild(el('div','empty','Er zijn nog geen (actieve) leerlingen toegevoegd door de leerkracht.'));
    } else {
      const row = el('div','row');

      const activeStudents = state.students.filter(s=>s.actief!==false).slice().sort((a,b)=>a.naam.localeCompare(b.naam));
      const studentLabel = (s)=> s.naam + (s.leerjaar ? ' ('+s.leerjaar+(s.klasgroep?s.klasgroep:'')+')' : '');

      const d1 = el('div');
      d1.appendChild(el('label','field','Leerling (typ om te zoeken)'));
      const studentInput = document.createElement('input'); studentInput.type='text'; studentInput.placeholder='Naam...'; studentInput.setAttribute('list','uitlenen-leerlingen');
      const studentDatalist = document.createElement('datalist'); studentDatalist.id='uitlenen-leerlingen';
      activeStudents.forEach(s=>{ const o=document.createElement('option'); o.value=studentLabel(s); studentDatalist.appendChild(o); });
      d1.appendChild(studentInput); d1.appendChild(studentDatalist);

      const sortedBeschikbaar = beschikbaar.slice().sort((a,b)=>a.naam.localeCompare(b.naam));
      const toyLabel = (t)=> t.naam + (t.categorie? ' ('+t.categorie+')':'') + ' — ' + toyAvailableCount(t) + ' besch.';

      const d2 = el('div');
      d2.appendChild(el('label','field','Speelgoed (typ om te zoeken)'));
      const toyInput = document.createElement('input'); toyInput.type='text'; toyInput.placeholder='Naam...'; toyInput.setAttribute('list','uitlenen-speelgoed');
      const toyDatalist = document.createElement('datalist'); toyDatalist.id='uitlenen-speelgoed';
      sortedBeschikbaar.forEach(t=>{ const o=document.createElement('option'); o.value=toyLabel(t); toyDatalist.appendChild(o); });
      d2.appendChild(toyInput); d2.appendChild(toyDatalist);

      const d4 = el('div');
      const btn = document.createElement('button');
      btn.className = 'primary'; btn.textContent = 'Uitlenen';
      btn.onclick = ()=>{
        const student = activeStudents.find(s=>studentLabel(s)===studentInput.value);
        const toy = sortedBeschikbaar.find(t=>toyLabel(t)===toyInput.value);
        if(!student){ toast('Kies een geldige leerling uit de lijst.'); return; }
        if(!toy){ toast('Kies een geldig, beschikbaar speelgoedstuk uit de lijst.'); return; }
        state.loans.push({ id: uid(), toyId: toy.id, studentId: student.id, beheerderIdUit: state.activeBeheerders.slice(), uitDatum: new Date().toISOString(), teruggegeven:false, beheerderIdTerug:null, terugDatum:null });
        setData('loans', state.loans);
        toast(student.naam + ' leende ' + toy.naam + ' uit.');
        render();
      };
      d4.appendChild(btn);

      row.appendChild(d1); row.appendChild(d2); row.appendChild(d4);
      uitleenCard.appendChild(row);
    }
    wrap.appendChild(uitleenCard);

    // terugbrengen
    const terugCard = el('div','card');
    terugCard.appendChild(el('h2','↩️ Speelgoed terugbrengen'));
    const openstaand = state.loans.filter(l=>!l.teruggegeven);
    if(openstaand.length===0){
      terugCard.appendChild(el('div','empty','Er staat momenteel niets uit.'));
    } else {
      const tbl = document.createElement('table');
      tbl.innerHTML = '<tr><th>Speelgoed</th><th>Leerling</th><th>Sinds</th><th></th></tr>';
      openstaand.slice().sort((a,b)=>new Date(b.uitDatum)-new Date(a.uitDatum)).forEach(l=>{
        const toy = state.toys.find(t=>t.id===l.toyId);
        const overdue = isOverdue(l);
        const tr = document.createElement('tr');
        if(overdue) tr.style.background = '#FDEDE9';
        tr.innerHTML = '<td>'+(toy?toy.naam:'?')+'</td><td>'+studentName(l.studentId)+'</td><td>'+fmtDate(l.uitDatum)+(overdue?' <span class="badge" style="background:var(--overdue); color:#fff;">te lang uit</span>':'')+'</td>';
        const td = document.createElement('td');
        const btn = document.createElement('button');
        btn.className = 'primary small'; btn.textContent = 'Teruggegeven';
        btn.onclick = ()=>{
          l.teruggegeven = true;
          l.beheerderIdTerug = state.activeBeheerders.slice();
          l.terugDatum = new Date().toISOString();
          setData('loans', state.loans);
          toast((toy?toy.naam:'Speelgoed') + ' is terug binnen.');
          render();
        };
        td.appendChild(btn);
        tr.appendChild(td);
        tbl.appendChild(tr);
      });
      terugCard.appendChild(tbl);
    }
    wrap.appendChild(terugCard);

    return wrap;
  }

  function viewOverzicht(){
    const wrap = el('div');
    wrap.appendChild(el('h1','page-title','Overzicht'));

    const statusCard = el('div','card');
    statusCard.appendChild(el('h2', state.activeBeheerders.length>0 ? '🔓 Kast is nu open' : '🔒 Kast is nu gesloten'));
    if(state.activeBeheerders.length>0){
      statusCard.appendChild(el('p','muted','Beheerder(s): ' + state.activeBeheerders.map(studentName).join(', ')));
    }
    wrap.appendChild(statusCard);

    const shelfCard = el('div','card');
    shelfCard.appendChild(el('h2','🧸 Speelgoedkast'));
    if(state.toys.length===0){
      shelfCard.appendChild(el('div','empty','Nog geen speelgoed toegevoegd.'));
    } else {
      const shelf = el('div','shelf');
      state.toys.slice().sort((a,b)=>a.naam.localeCompare(b.naam)).forEach(t=>{
        const aantal = t.aantal||1;
        const avail = toyAvailableCount(t);
        const loansForToy = state.loans.filter(l=>l.toyId===t.id && !l.teruggegeven);
        const overdue = loansForToy.some(isOverdue);
        const cls = avail>0 ? 'free' : (overdue ? 'overdue' : 'taken');
        const meta = t.categorie || '';
        const wieRegel = loansForToy.length>0 ? ('bij ' + loansForToy.map(l=>studentName(l.studentId)).join(', ') + (overdue?' ⚠️':'')) : '';
        const slot = el('div','slot ' + cls);
        slot.innerHTML = '<div class="name">'+t.naam+'</div><div class="who">'+avail+' / '+aantal+' beschikbaar'+(meta?' · '+meta:'')+(wieRegel?'<br>'+wieRegel:'')+'</div>';
        shelf.appendChild(slot);
      });
      shelfCard.appendChild(shelf);
    }
    wrap.appendChild(shelfCard);

    const histCard = el('div','card');
    histCard.appendChild(el('h2','🕓 Recente ontleningen'));
    const recent = state.loans.slice().sort((a,b)=>new Date(b.uitDatum)-new Date(a.uitDatum)).slice(0,15);
    if(recent.length===0){
      histCard.appendChild(el('div','empty','Nog geen geschiedenis.'));
    } else {
      const tbl = document.createElement('table');
      tbl.innerHTML = '<tr><th>Speelgoed</th><th>Leerling</th><th>Uitgeleend</th><th>Status</th></tr>';
      recent.forEach(l=>{
        const toy = state.toys.find(t=>t.id===l.toyId);
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>'+(toy?toy.naam:'?')+'</td><td>'+studentName(l.studentId)+'</td><td>'+fmtDate(l.uitDatum)+'</td><td>'+(l.teruggegeven? 'Terug ('+fmtDate(l.terugDatum)+')' : (isOverdue(l) ? '<b style="color:var(--overdue);">⚠️ Te lang uit</b>' : '<b>Nog buiten</b>'))+'</td>';
        tbl.appendChild(tr);
      });
      histCard.appendChild(tbl);
    }
    wrap.appendChild(histCard);

    return wrap;
  }

  // ==========================================================================
  // 12. LEERKRACHT-BEHEER (leerlingen, speelgoed, geschiedenis, statistieken, instellingen)
  // ==========================================================================
  let adminTab = 'leerlingen';
  function viewAdmin(){
    const wrap = el('div');
    wrap.appendChild(el('h1','page-title','Leerkracht'));

    if(!adminUnlocked){
      const lock = el('div','lockscreen');
      lock.appendChild(el('div','icon','🔒'));
      lock.appendChild(el('p','muted','Voer de pincode in.'));
      const input = document.createElement('input');
      input.type = 'password'; input.placeholder = 'Pincode';
      input.style.marginBottom = '12px';
      const btn = document.createElement('button');
      btn.className = 'primary'; btn.style.width='100%'; btn.textContent='Ontgrendelen';
      btn.onclick = ()=>{
        if(input.value === state.config.pin){ adminUnlocked = true; render(); }
        else toast('Foute pincode.');
      };
      input.onkeydown = (e)=>{ if(e.key==='Enter') btn.click(); };
      lock.appendChild(input); lock.appendChild(btn);
      wrap.appendChild(lock);
      return wrap;
    }

    const tabs = el('div','tabs');
    [['leerlingen','Leerlingen'],['speelgoed','Speelgoed'],['geschiedenis','Geschiedenis'],['statistieken','Statistieken'],['instellingen','Instellingen']].forEach(([t,label])=>{
      const b = document.createElement('button');
      b.textContent = label;
      if(adminTab===t) b.classList.add('active');
      b.onclick = ()=>{ adminTab=t; render(); };
      tabs.appendChild(b);
    });
    wrap.appendChild(tabs);

    if(adminTab==='leerlingen') wrap.appendChild(adminLeerlingen());
    else if(adminTab==='speelgoed') wrap.appendChild(adminSpeelgoed());
    else if(adminTab==='geschiedenis') wrap.appendChild(adminGeschiedenis());
    else if(adminTab==='statistieken') wrap.appendChild(adminStatistieken());
    else wrap.appendChild(adminInstellingen());

    return wrap;
  }

  function adminLeerlingen(){
    const card = el('div','card');
    card.appendChild(el('h2','Leerling toevoegen'));
    const row = el('div','row');
    const d1 = el('div'); d1.appendChild(el('label','field','Naam'));
    const nameInput = document.createElement('input'); nameInput.type='text'; nameInput.placeholder='Voornaam';
    d1.appendChild(nameInput);

    const d2 = el('div'); d2.appendChild(el('label','field','Leerjaar'));
    const leerjaarSelect = document.createElement('select');
    ['1','2','3','4','5','6'].forEach(j=>{
      const o = document.createElement('option'); o.value=j; o.textContent='Leerjaar '+j; leerjaarSelect.appendChild(o);
    });
    d2.appendChild(leerjaarSelect);

    const d3 = el('div'); d3.appendChild(el('label','field','Klas'));
    const klasgroepSelect = document.createElement('select');
    const klasPlaceholder = document.createElement('option'); klasPlaceholder.value=''; klasPlaceholder.textContent='Kies A, B of C'; klasPlaceholder.disabled=true; klasPlaceholder.selected=true;
    klasgroepSelect.appendChild(klasPlaceholder);
    ['A','B','C'].forEach(k=>{ const o=document.createElement('option'); o.value=k; o.textContent=k; klasgroepSelect.appendChild(o); });
    d3.appendChild(klasgroepSelect);

    const d4 = el('div'); d4.appendChild(el('label','field','Opmerking (optioneel)'));
    const opmerkingInput = document.createElement('input'); opmerkingInput.type='text'; opmerkingInput.placeholder='bv. korte praktische notitie';
    d4.appendChild(opmerkingInput);

    const d5 = el('div');
    const addBtn = document.createElement('button'); addBtn.className='primary'; addBtn.textContent='Toevoegen';
    addBtn.onclick = ()=>{
      if(!nameInput.value.trim()) { toast('Geef een naam in.'); return; }
      if(!klasgroepSelect.value) { toast('Kies een klas (A, B of C).'); return; }
      const leerjaar = leerjaarSelect.value;
      state.students.push({
        id: uid(), naam: nameInput.value.trim(), leerjaar, klasgroep: klasgroepSelect.value,
        opmerking: opmerkingInput.value.trim(), actief: true, kanBeheerder: leerjaar === '6'
      });
      setData('students', state.students);
      toast('Leerling toegevoegd.');
      render();
    };
    d5.appendChild(addBtn);
    row.appendChild(d1); row.appendChild(d2); row.appendChild(d3); row.appendChild(d4); row.appendChild(d5);
    card.appendChild(row);

    // bulk-import
    const bulkCard = el('div','card');
    bulkCard.appendChild(el('h2','📋 Volledige klas in één keer toevoegen'));
    bulkCard.appendChild(el('p','muted','Plak of typ één naam per lijn. Leerjaar en klasgroep gelden voor de hele lijst.'));
    const brow = el('div','row');
    const bd1 = el('div'); bd1.appendChild(el('label','field','Leerjaar'));
    const bulkLeerjaar = document.createElement('select');
    ['1','2','3','4','5','6'].forEach(j=>{ const o=document.createElement('option'); o.value=j; o.textContent='Leerjaar '+j; bulkLeerjaar.appendChild(o); });
    bd1.appendChild(bulkLeerjaar);
    const bd2 = el('div'); bd2.appendChild(el('label','field','Klas'));
    const bulkKlasgroep = document.createElement('select');
    const bulkKlasPlaceholder = document.createElement('option'); bulkKlasPlaceholder.value=''; bulkKlasPlaceholder.textContent='Kies A, B of C'; bulkKlasPlaceholder.disabled=true; bulkKlasPlaceholder.selected=true;
    bulkKlasgroep.appendChild(bulkKlasPlaceholder);
    ['A','B','C'].forEach(k=>{ const o=document.createElement('option'); o.value=k; o.textContent=k; bulkKlasgroep.appendChild(o); });
    bd2.appendChild(bulkKlasgroep);
    brow.appendChild(bd1); brow.appendChild(bd2);
    bulkCard.appendChild(brow);
    const namesArea = document.createElement('textarea');
    namesArea.rows = 5; namesArea.placeholder = 'Emma\nNoah\nLouise\n...';
    namesArea.style.width='100%'; namesArea.style.fontFamily='Inter, sans-serif'; namesArea.style.fontSize='14.5px';
    namesArea.style.padding='10px 12px'; namesArea.style.border='2px solid var(--line)'; namesArea.style.borderRadius='10px'; namesArea.style.marginBottom='12px';
    bulkCard.appendChild(namesArea);
    const bulkBtn = document.createElement('button'); bulkBtn.className='primary'; bulkBtn.textContent='Voeg allemaal toe';
    bulkBtn.onclick = ()=>{
      const names = namesArea.value.split('\n').map(n=>n.trim()).filter(Boolean);
      if(names.length===0){ toast('Vul minstens één naam in.'); return; }
      if(!bulkKlasgroep.value){ toast('Kies een klas (A, B of C).'); return; }
      const leerjaar = bulkLeerjaar.value;
      names.forEach(naam=>{
        state.students.push({ id: uid(), naam, leerjaar, klasgroep: bulkKlasgroep.value, opmerking:'', actief:true, kanBeheerder: leerjaar==='6' });
      });
      setData('students', state.students);
      toast(names.length + ' leerling(en) toegevoegd.');
      namesArea.value = '';
      render();
    };
    bulkCard.appendChild(bulkBtn);

    const listCard = el('div','card');
    listCard.appendChild(el('h2','Alle leerlingen ('+state.students.length+')'));
    const searchInput = document.createElement('input'); searchInput.type='text'; searchInput.placeholder='🔍 Zoek op naam...'; searchInput.style.marginBottom='12px';
    searchInput.value = leerlingenZoek;
    searchInput.oninput = ()=>{ leerlingenZoek = searchInput.value; renderFilteredLeerlingen(); };
    listCard.appendChild(searchInput);
    const tableHolder = el('div');
    listCard.appendChild(tableHolder);

    function renderFilteredLeerlingen(){
      tableHolder.innerHTML = '';
      const term = leerlingenZoek.trim().toLowerCase();
      const filtered = state.students.filter(s=>!term || s.naam.toLowerCase().includes(term));
      if(filtered.length===0){
        tableHolder.appendChild(el('div','empty', state.students.length===0 ? 'Nog geen leerlingen.' : 'Geen leerlingen gevonden.'));
        return;
      }
      const tbl = document.createElement('table');
      tbl.innerHTML = '<tr><th>Naam</th><th>Leerjaar</th><th>Klas</th><th>6de leerjaar</th><th>Status</th><th>Opmerking</th><th></th></tr>';
      filtered.slice().sort((a,b)=>a.naam.localeCompare(b.naam)).forEach(s=>{
        const tr = document.createElement('tr');
        if(s.actief===false) tr.style.opacity='0.55';
        tr.innerHTML = '<td>'+s.naam+'</td><td>'+(s.leerjaar||'-')+'</td><td>'+(s.klasgroep||'-')+'</td><td>'+(s.kanBeheerder?'✅':'—')+'</td>'
          + '<td>'+(s.actief===false?'Inactief':'Actief')+'</td><td>'+(s.opmerking||'')+'</td>';
        const td = document.createElement('td');
        const toggleBtn = document.createElement('button'); toggleBtn.className='secondary small'; toggleBtn.textContent = s.actief===false ? 'Actief maken' : 'Inactief maken';
        toggleBtn.onclick = ()=>{
          s.actief = s.actief===false ? true : false;
          setData('students', state.students);
          render();
        };
        const del = document.createElement('button'); del.className='danger'; del.style.marginLeft='6px'; del.textContent='Verwijderen';
        del.onclick = ()=>{
          if(!confirm('Weet je zeker dat je "' + s.naam + '" wilt verwijderen?')) return;
          state.students = state.students.filter(x=>x.id!==s.id);
          state.activeBeheerders = state.activeBeheerders.filter(id=>id!==s.id);
          setData('students', state.students); setData('activeBeheerders', state.activeBeheerders);
          toast('Leerling verwijderd.'); render();
        };
        td.appendChild(toggleBtn); td.appendChild(del); tr.appendChild(td);
        tbl.appendChild(tr);
      });
      tableHolder.appendChild(tbl);
    }
    renderFilteredLeerlingen();
    listCard.appendChild(el('p','muted','Inactieve leerlingen (bv. van school veranderd) verdwijnen uit de keuzelijsten, maar blijven zichtbaar in de geschiedenis.'));

    const wrap = el('div');
    wrap.appendChild(card); wrap.appendChild(bulkCard); wrap.appendChild(listCard);
    return wrap;
  }

  function adminSpeelgoed(){
    const card = el('div','card');
    card.appendChild(el('h2','Speelgoed toevoegen'));
    const row = el('div','row');
    const d1 = el('div'); d1.appendChild(el('label','field','Naam'));
    const nameInput = document.createElement('input'); nameInput.type='text'; nameInput.placeholder='bv. Bal, springtouw...';
    d1.appendChild(nameInput);

    const d2 = el('div'); d2.appendChild(el('label','field','Categorie'));
    const catInput = document.createElement('input'); catInput.type='text'; catInput.placeholder='bv. Bal'; catInput.setAttribute('list','categorie-opties');
    const catList = document.createElement('datalist'); catList.id='categorie-opties';
    ['Bal','Bordspel','Behendigheid','Buitenspel','Constructie','Gezelschap','Knutselen','Andere'].forEach(c=>{
      const o=document.createElement('option'); o.value=c; catList.appendChild(o);
    });
    d2.appendChild(catInput); d2.appendChild(catList);

    const d4 = el('div'); d4.appendChild(el('label','field','Aantal'));
    const aantalInput = document.createElement('input'); aantalInput.type='number'; aantalInput.min='1'; aantalInput.step='1'; aantalInput.value='1';
    d4.appendChild(aantalInput);

    const d5 = el('div');
    const addBtn = document.createElement('button'); addBtn.className='primary'; addBtn.textContent='Toevoegen';
    addBtn.onclick = ()=>{
      if(!nameInput.value.trim()){ toast('Geef een naam in.'); return; }
      const aantal = Math.max(1, parseInt(aantalInput.value,10) || 1);
      state.toys.push({
        id: uid(), naam: nameInput.value.trim(), categorie: catInput.value.trim(), aantal
      });
      setData('toys', state.toys);
      toast('Speelgoed toegevoegd.'); render();
    };
    d5.appendChild(addBtn);
    row.appendChild(d1); row.appendChild(d2); row.appendChild(d4); row.appendChild(d5);
    card.appendChild(row);

    const listCard = el('div','card');
    listCard.appendChild(el('h2','Alle speelgoed ('+state.toys.length+')'));
    const searchInput = document.createElement('input'); searchInput.type='text'; searchInput.placeholder='🔍 Zoek op naam...'; searchInput.style.marginBottom='12px';
    searchInput.value = speelgoedZoek;
    searchInput.oninput = ()=>{ speelgoedZoek = searchInput.value; renderFilteredSpeelgoed(); };
    listCard.appendChild(searchInput);
    const tableHolder = el('div');
    listCard.appendChild(tableHolder);

    function renderFilteredSpeelgoed(){
      tableHolder.innerHTML = '';
      const term = speelgoedZoek.trim().toLowerCase();
      const filtered = state.toys.filter(t=>!term || t.naam.toLowerCase().includes(term) || (t.categorie||'').toLowerCase().includes(term));
      if(filtered.length===0){
        tableHolder.appendChild(el('div','empty', state.toys.length===0 ? 'Nog geen speelgoed.' : 'Geen speelgoed gevonden.'));
        return;
      }
      const tbl = document.createElement('table');
      tbl.innerHTML = '<tr><th>Naam</th><th>Categorie</th><th>Aantal</th><th>Beschikbaar</th><th></th></tr>';
      filtered.slice().sort((a,b)=>a.naam.localeCompare(b.naam)).forEach(t=>{
        const tr = document.createElement('tr');
        const naamTd = '<td>'+t.naam+'</td><td>'+(t.categorie||'-')+'</td>';
        tr.innerHTML = naamTd;
        const aantalTd = document.createElement('td');
        const aantalEdit = document.createElement('input'); aantalEdit.type='number'; aantalEdit.min='1'; aantalEdit.step='1';
        aantalEdit.value = t.aantal||1; aantalEdit.style.width='64px'; aantalEdit.style.padding='6px 8px';
        aantalEdit.onchange = ()=>{
          t.aantal = Math.max(1, parseInt(aantalEdit.value,10) || 1);
          setData('toys', state.toys);
          toast('Aantal bijgewerkt.'); render();
        };
        aantalTd.appendChild(aantalEdit); tr.appendChild(aantalTd);
        const beschikbaarTd = document.createElement('td'); beschikbaarTd.textContent = toyAvailableCount(t) + ' / ' + (t.aantal||1);
        tr.appendChild(beschikbaarTd);
        const td = document.createElement('td');
        const del = document.createElement('button'); del.className='danger'; del.textContent='Verwijderen';
        del.onclick = ()=>{
          if(!confirm('Weet je zeker dat je "' + t.naam + '" wilt verwijderen?')) return;
          state.toys = state.toys.filter(x=>x.id!==t.id);
          setData('toys', state.toys);
          toast('Speelgoed verwijderd.'); render();
        };
        td.appendChild(del); tr.appendChild(td);
        tbl.appendChild(tr);
      });
      tableHolder.appendChild(tbl);
    }
    renderFilteredSpeelgoed();

    const wrap = el('div');
    wrap.appendChild(card); wrap.appendChild(listCard);
    return wrap;
  }

  function adminGeschiedenis(){
    const card = el('div','card');
    card.appendChild(el('h2','Volledige geschiedenis'));
    if(state.loans.length===0){
      card.appendChild(el('div','empty','Nog geen ontleningen.'));
    } else {
      const tbl = document.createElement('table');
      tbl.innerHTML = '<tr><th>Speelgoed</th><th>Leerling</th><th>Uitgeleend door</th><th>Uitgeleend op</th><th>Teruggegeven op</th></tr>';
      state.loans.slice().sort((a,b)=>new Date(b.uitDatum)-new Date(a.uitDatum)).forEach(l=>{
        const toy = state.toys.find(t=>t.id===l.toyId);
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>'+(toy?toy.naam:'(verwijderd)')+'</td><td>'+studentName(l.studentId)+'</td><td>'+beheerderNames(l.beheerderIdUit)+'</td><td>'+fmtDate(l.uitDatum)+'</td><td>'+(l.teruggegeven ? fmtDate(l.terugDatum)+' (via '+beheerderNames(l.beheerderIdTerug)+')' : '<b>nog buiten</b>')+'</td>';
        tbl.appendChild(tr);
      });
      card.appendChild(tbl);
    }
    const wrap = el('div'); wrap.appendChild(card);
    return wrap;
  }

  function adminStatistieken(){
    const wrap = el('div');
    if(state.loans.length===0){
      const empty = el('div','card'); empty.appendChild(el('div','empty','Nog geen ontleningen om statistieken over te tonen.'));
      wrap.appendChild(empty);
      return wrap;
    }

    // populairste speelgoed
    const perToy = {};
    state.loans.forEach(l=>{ perToy[l.toyId] = (perToy[l.toyId]||0) + 1; });
    const topToys = Object.entries(perToy).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([toyId,count])=>{
      const toy = state.toys.find(t=>t.id===toyId);
      return { naam: toy?toy.naam:'(verwijderd)', count };
    });
    const toyCard = el('div','card');
    toyCard.appendChild(el('h2','🏆 Populairste speelgoed'));
    const toyTbl = document.createElement('table');
    toyTbl.innerHTML = '<tr><th>Speelgoed</th><th>Aantal keer ontleend</th></tr>';
    topToys.forEach(t=>{ const tr=document.createElement('tr'); tr.innerHTML='<td>'+t.naam+'</td><td>'+t.count+'</td>'; toyTbl.appendChild(tr); });
    toyCard.appendChild(toyTbl);
    wrap.appendChild(toyCard);

    // gemiddelde uitleenduur
    const teruggegeven = state.loans.filter(l=>l.teruggegeven && l.terugDatum);
    const durCard = el('div','card');
    durCard.appendChild(el('h2','⏱️ Gemiddelde uitleenduur'));
    if(teruggegeven.length===0){
      durCard.appendChild(el('div','empty','Nog geen teruggegeven speelgoed om een gemiddelde te berekenen.'));
    } else {
      const totalMs = teruggegeven.reduce((sum,l)=> sum + (new Date(l.terugDatum) - new Date(l.uitDatum)), 0);
      const avgMs = totalMs / teruggegeven.length;
      const avgMin = Math.round(avgMs / 60000);
      const label = avgMin < 60 ? (avgMin + ' minuten') : avgMin < 1440 ? (Math.round(avgMin/60*10)/10 + ' uur') : (Math.round(avgMin/1440*10)/10 + ' dagen');
      durCard.appendChild(el('p','', '<b>' + label + '</b> gemiddeld, over ' + teruggegeven.length + ' teruggegeven ontleningen.'));
    }
    wrap.appendChild(durCard);

    // ontleningen per leerjaar
    const perLeerjaar = {};
    state.loans.forEach(l=>{
      const s = state.students.find(x=>x.id===l.studentId);
      const key = s && s.leerjaar ? ('Leerjaar ' + s.leerjaar) : 'Onbekend';
      perLeerjaar[key] = (perLeerjaar[key]||0) + 1;
    });
    const leerjaarCard = el('div','card');
    leerjaarCard.appendChild(el('h2','🏫 Ontleningen per leerjaar'));
    const ljTbl = document.createElement('table');
    ljTbl.innerHTML = '<tr><th>Leerjaar</th><th>Aantal ontleningen</th></tr>';
    Object.entries(perLeerjaar).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{ const tr=document.createElement('tr'); tr.innerHTML='<td>'+k+'</td><td>'+v+'</td>'; ljTbl.appendChild(tr); });
    leerjaarCard.appendChild(ljTbl);
    wrap.appendChild(leerjaarCard);

    return wrap;
  }

  function adminInstellingen(){
    const card = el('div','card');
    card.appendChild(el('h2','School &amp; pincode'));
    const row = el('div','row');
    const d0 = el('div'); d0.appendChild(el('label','field','Schoolnaam'));
    const naamInput = document.createElement('input'); naamInput.type='text'; naamInput.value = state.config.schoolNaam || '';
    d0.appendChild(naamInput);
    const d1 = el('div'); d1.appendChild(el('label','field','Pincode'));
    const input = document.createElement('input'); input.type='text'; input.value = state.config.pin;
    d1.appendChild(input);
    const d2 = el('div');
    const btn = document.createElement('button'); btn.className='primary'; btn.textContent='Opslaan';
    btn.onclick = ()=>{
      state.config.pin = input.value.trim() || '1234';
      state.config.schoolNaam = naamInput.value.trim() || 'Onze school';
      setData('config', state.config);
      toast('Instellingen opgeslagen.');
      render();
    };
    d2.appendChild(btn);
    row.appendChild(d0); row.appendChild(d1); row.appendChild(d2);
    card.appendChild(row);

    const sheetsCard = el('div','card');
    sheetsCard.appendChild(el('h2','🌐 Gedeelde online opslag (Google Sheets)'));
    sheetsCard.appendChild(el('p','muted','Werkt op elk toestel — ook tablets en Chromebooks — en houdt alle PC\'s meteen up-to-date. Vereist eenmalig een gratis Google Sheet + Apps Script-koppeling (zie README).'));
    if(state.config.sheetsUrl){
      sheetsCard.appendChild(el('div','','<b>✅ Gekoppeld</b><br><span class="muted">'+state.config.sheetsUrl+'</span>'));
      const dcBtn = document.createElement('button'); dcBtn.className='danger'; dcBtn.style.marginTop='10px'; dcBtn.textContent='Ontkoppelen';
      dcBtn.onclick = ()=>disconnectSheets();
      sheetsCard.appendChild(dcBtn);
    } else {
      const srow = el('div','row');
      const sd = el('div'); sd.appendChild(el('label','field','Apps Script Web App-URL'));
      const sinput = document.createElement('input'); sinput.type='text'; sinput.placeholder='https://script.google.com/macros/s/.../exec';
      sd.appendChild(sinput);
      const sbtn = document.createElement('button'); sbtn.className='primary'; sbtn.textContent='Verbinden';
      sbtn.onclick = ()=>connectSheets(sinput.value);
      srow.appendChild(sd); srow.appendChild(sbtn);
      sheetsCard.appendChild(srow);
    }

    const fileCard = el('div','card');
    fileCard.appendChild(el('h2','📄 Koppelen aan Excel-bestand (aanbevolen)'));
    if(!FS_SUPPORTED){
      fileCard.appendChild(el('div','empty','Deze browser ondersteunt geen bestandskoppeling. Gebruik Chrome of Edge voor deze functie — de gewone back-up hierboven blijft wel altijd werken.'));
    } else {
      fileCard.appendChild(el('p','muted','Koppel de app aan een .xlsx-bestand dat je bewaart in je OneDrive-map van de scholengroep. Elke wijziging wordt automatisch weggeschreven — jullie eigen OneDrive zorgt dan voor de back-up naar de cloud van de scholengroep, zonder dat deze app zelf iets online stuurt.'));
      const statusRow = el('div','row');
      if(fileHandleConnected()){
        statusRow.appendChild(el('div','','<b>✅ Gekoppeld aan:</b> ' + fileHandle.name));
      } else if(fileHandle){
        statusRow.appendChild(el('div','','<b>⚠️ Verbinding verbroken</b> met ' + fileHandle.name + ' — klik om te herstellen.'));
      } else {
        statusRow.appendChild(el('div','','<b>Niet gekoppeld</b> — data zit enkel lokaal in deze browser.'));
      }
      fileCard.appendChild(statusRow);
      statusRow.style.marginBottom = '14px';

      const btnRow = el('div','row');
      if(fileHandle && !fileHandleConnected()){
        const reconnectBtn = document.createElement('button'); reconnectBtn.className='primary'; reconnectBtn.textContent='🔄 Verbinding herstellen';
        reconnectBtn.onclick = async ()=>{
          try{
            const perm = await fileHandle.requestPermission({mode:'readwrite'});
            if(perm==='granted'){ fileHandlePermGranted = true; await loadFromFile(fileHandle); toast('Verbinding hersteld.'); render(); startPolling(); }
            else toast('Toestemming geweigerd.');
          }catch(e){ toast('Kon de verbinding niet herstellen.'); }
        };
        btnRow.appendChild(reconnectBtn);
      }
      const newBtn = document.createElement('button'); newBtn.className='secondary'; newBtn.textContent='📁 Nieuw bestand aanmaken';
      newBtn.onclick = ()=>linkNewFile();
      const existBtn = document.createElement('button'); existBtn.className='secondary'; existBtn.textContent='📂 Bestaand bestand kiezen';
      existBtn.onclick = ()=>linkExistingFile();
      btnRow.appendChild(newBtn); btnRow.appendChild(existBtn);
      if(fileHandle){
        const unlinkBtn = document.createElement('button'); unlinkBtn.className='danger'; unlinkBtn.textContent='Ontkoppelen';
        unlinkBtn.onclick = ()=>unlinkFile();
        btnRow.appendChild(unlinkBtn);
      }
      fileCard.appendChild(btnRow);
    }

    const backupCard = el('div','card');
    backupCard.appendChild(el('h2','Back-up'));
    backupCard.appendChild(el('p','muted','Alle data staat enkel lokaal op dit toestel. Maak regelmatig een back-up, zeker voor je de browser opschoont of naar een nieuwe PC verhuist.'));
    const brow = el('div','row');
    const exportBtn = document.createElement('button'); exportBtn.className='secondary'; exportBtn.textContent='⬇️ Back-up downloaden';
    exportBtn.onclick = ()=>exportBackup();
    const importLabel = document.createElement('label'); importLabel.className='secondary'; importLabel.style.display='inline-block'; importLabel.style.cursor='pointer';
    importLabel.textContent = '⬆️ Back-up terugzetten';
    const fileInput = document.createElement('input'); fileInput.type='file'; fileInput.accept='application/json'; fileInput.style.display='none';
    fileInput.onchange = (e)=>{ if(e.target.files[0]) importBackup(e.target.files[0]); };
    importLabel.appendChild(fileInput);
    brow.appendChild(exportBtn); brow.appendChild(importLabel);
    backupCard.appendChild(brow);

    const resetCard = el('div','card');
    resetCard.appendChild(el('h2','Kast forceren sluiten'));
    resetCard.appendChild(el('p','muted','Gebruik dit als de kast per ongeluk open bleef staan.'));
    const resetBtn = document.createElement('button'); resetBtn.className='secondary'; resetBtn.textContent='Kast sluiten';
    resetBtn.onclick = async ()=>{
      state.activeBeheerders = [];
      await setData('activeBeheerders', []);
      toast('Kast gesloten.'); render();
    };
    resetCard.appendChild(resetBtn);

    const wrap = el('div'); wrap.appendChild(card); wrap.appendChild(sheetsCard); wrap.appendChild(fileCard); wrap.appendChild(backupCard); wrap.appendChild(resetCard);
    return wrap;
  }

  // ==========================================================================
  // 13. OPSTART
  // ==========================================================================
  (async function init(){
    loadAll();
    await applyUrlConfig();
    if(state.config.sheetsUrl){
      try{ const remote = await fetchFromSheets(state.config.sheetsUrl);
        if(remote && (remote.students || remote.toys || remote.loans)){
          state = { config: {...state.config, ...(remote.config||{}), sheetsUrl: state.config.sheetsUrl}, students: remote.students||[], toys: remote.toys||[], activeBeheerders: remote.activeBeheerders||[], loans: remote.loans||[] };
        }
      }catch(e){ console.error('kon niet laden van Google Sheets, val terug op lokale kopie', e); }
    }
    await tryReconnectOnStartup();
    render();
    startPolling();
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('./sw.js').catch(()=>{});
    }
  })();

})();
