
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
   *   7. Live verversen (multi-toestel polling)
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
  const APP_VERSION = '1.2.1';
  const DEFAULT_CONFIG = { pin: "1234", schoolNaam: "", ingesteld: false, sheetsUrl: "" };
  let state = {
    config: DEFAULT_CONFIG,
    students: [],       // {id, naam, klas, kanBeheerder}
    toys: [],           // {id, naam, status}
    activeBeheerders: [], // array of student ids, kast open when length>0
    loans: []           // {id, toyId, studentId, beheerderIdUit, uitDatum, teruggegeven, beheerderIdTerug, terugDatum}
  };
  let startupStatus = 'loading';
  let startupError = '';
  let startupUpdateVersion = '';
  let startupUpdateError = '';
  let startupCanInitializeEmpty = false;
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
  let cloudWritesEnabled = false;
  let cloudRevision = 0;
  let cloudBaseState = null;
  let cloudSyncError = '';
  let cloudSyncQueue = Promise.resolve();
  function getData(key, fallback){
    try{
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw ? JSON.parse(raw) : fallback;
    }catch(e){ return fallback; }
  }
  function setData(key, value){
    saveLocalData(key, value);
    scheduleFileSync();
    scheduleCloudSync();
  }
  function saveLocalData(key, value){
    try{
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
      return true;
    }catch(e){
      console.error('storage set failed', key, e);
      toast('Opslaan mislukt — is de browseropslag vol of uitgeschakeld?');
      return false;
    }
  }
  function saveStateLocally(){
    saveLocalData('config', state.config);
    saveLocalData('students', state.students);
    saveLocalData('toys', state.toys);
    saveLocalData('activeBeheerders', state.activeBeheerders);
    saveLocalData('loans', state.loans);
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

  function el(tag, cls, text){
    const e = document.createElement(tag);
    if(cls) e.className = cls;
    if(text!==undefined) e.textContent = text;
    return e;
  }
  function appendTextCell(row, text){
    const cell = document.createElement('td');
    cell.textContent = text == null ? '' : String(text);
    row.appendChild(cell);
    return cell;
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
  const CLOUD_SYNC_DEBOUNCE_MS = 250;
  let cloudSyncTimer = null;
  let cloudSyncing = false;
  function cloneValue(value){
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  function stableStringify(value){
    if(value === undefined) return 'undefined';
    if(value === null || typeof value !== 'object') return JSON.stringify(value);
    if(Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort()
      .filter(key=>value[key] !== undefined)
      .map(key=>JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  function valuesEqual(a, b){ return stableStringify(a) === stableStringify(b); }
  function cloudDataFromState(value){
    return {
      students: cloneValue(value.students),
      toys: cloneValue(value.toys),
      loans: cloneValue(value.loans)
    };
  }
  function mergeThreeWay(base, local, remote, path){
    if(valuesEqual(local, base)) return cloneValue(remote);
    if(valuesEqual(remote, base) || valuesEqual(local, remote)) return cloneValue(local);
    if(Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)){
      return mergeArrayThreeWay(base, local, remote, path);
    }
    if(isPlainObject(base) && isPlainObject(local) && isPlainObject(remote)){
      const merged = {};
      const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
      keys.forEach(key=>{
        const value = mergeThreeWay(base[key], local[key], remote[key], path + '.' + key);
        if(value !== undefined) merged[key] = value;
      });
      return merged;
    }
    throw new Error('Gelijktijdige wijzigingen botsen bij ' + path + '.');
  }
  function isPlainObject(value){
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function mergeArrayThreeWay(base, local, remote, path){
    const all = base.concat(local, remote);
    const records = all.length > 0 && all.every(item=>isPlainObject(item) && item.id !== undefined && item.id !== null);
    if(records){
      const maps = [base, local, remote].map(items=>{
        const map = new Map();
        items.forEach(item=>{
          const id = String(item.id);
          if(map.has(id)) throw new Error('Dubbele ID gevonden in ' + path + '.');
          map.set(id, item);
        });
        return map;
      });
      const ids = new Set([...maps[2].keys(), ...maps[1].keys(), ...maps[0].keys()]);
      const merged = [];
      ids.forEach(id=>{
        const baseItem = maps[0].get(id);
        const localItem = maps[1].get(id);
        const remoteItem = maps[2].get(id);
        const item = path === 'ontleningen' && baseItem && !baseItem.teruggegeven &&
          localItem && localItem.teruggegeven && remoteItem && remoteItem.teruggegeven
          ? mergeConcurrentLoanReturns(baseItem, localItem, remoteItem, path + '[' + id + ']')
          : mergeThreeWay(baseItem, localItem, remoteItem, path + '[' + id + ']');
        if(item !== undefined) merged.push(item);
      });
      return merged;
    }
    if(all.some(value=>isPlainObject(value) || Array.isArray(value))){
      throw new Error('Kan de gelijktijdige wijzigingen in ' + path + ' niet veilig samenvoegen.');
    }
    const keys = value=>new Set(value.map(item=>stableStringify(item)));
    const baseKeys = keys(base), localKeys = keys(local), remoteKeys = keys(remote);
    const values = new Map();
    base.concat(local, remote).forEach(item=>values.set(stableStringify(item), item));
    const mergedKeys = new Set();
    values.forEach((value, key)=>{
      const wasPresent = baseKeys.has(key);
      const localPresent = localKeys.has(key);
      const remotePresent = remoteKeys.has(key);
      const localChanged = localPresent !== wasPresent;
      const remoteChanged = remotePresent !== wasPresent;
      if(localChanged && remoteChanged && localPresent !== remotePresent){
        throw new Error('Gelijktijdige wijzigingen botsen bij ' + path + '.');
      }
      if(localPresent || remotePresent) mergedKeys.add(key);
    });
    const ordered = remote.concat(local, base);
    const merged = [];
    ordered.forEach(item=>{
      const key = stableStringify(item);
      if(mergedKeys.has(key)){
        merged.push(values.get(key));
        mergedKeys.delete(key);
      }
    });
    return merged;
  }
  function mergeConcurrentLoanReturns(base, local, remote, path){
    const localDate = Date.parse(local.terugDatum);
    const remoteDate = Date.parse(remote.terugDatum);
    const localKey = Number.isNaN(localDate) ? Infinity : localDate;
    const remoteKey = Number.isNaN(remoteDate) ? Infinity : remoteDate;
    const returnedBy = localKey < remoteKey ||
      (localKey === remoteKey && stableStringify(local.beheerderIdTerug) <= stableStringify(remote.beheerderIdTerug))
      ? local
      : remote;
    const merged = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    keys.forEach(key=>{
      if(key === 'terugDatum' || key === 'beheerderIdTerug'){
        const value = returnedBy[key];
        if(value !== undefined) merged[key] = cloneValue(value);
        return;
      }
      const value = mergeThreeWay(base[key], local[key], remote[key], path + '.' + key);
      if(value !== undefined) merged[key] = value;
    });
    return merged;
  }
  function mergeCloudStates(base, local, remote, url){
    const merged = {
      config: {...local.config, ...(remote.config||{}), sheetsUrl: url},
      students: mergeThreeWay(base.students, local.students, remote.students, 'leerlingen'),
      toys: mergeThreeWay(base.toys, local.toys, remote.toys, 'speelgoed'),
      loans: mergeThreeWay(base.loans, local.loans, remote.loans, 'ontleningen'),
      activeBeheerders: Array.isArray(remote.activeBeheerders) ? cloneValue(remote.activeBeheerders) : []
    };
    validateMergedCloudState(merged);
    return merged;
  }
  function validateMergedCloudState(value){
    const toyIds = new Set(value.toys.map(toy=>String(toy.id)));
    const loanIds = new Set();
    const loanedByToy = new Map();
    value.loans.forEach(loan=>{
      if(loanIds.has(String(loan.id))) throw new Error('Een ontlening staat dubbel in de samengevoegde gegevens.');
      loanIds.add(String(loan.id));
      if(!loan.teruggegeven && !toyIds.has(String(loan.toyId))){
        throw new Error('Een ontlening verwijst naar speelgoed dat intussen verwijderd is.');
      }
      if(!loan.teruggegeven){
        const toyId = String(loan.toyId);
        loanedByToy.set(toyId, (loanedByToy.get(toyId)||0) + 1);
      }
    });
    value.toys.forEach(toy=>{
      const availableCount = Number(toy.aantal) || 1;
      if((loanedByToy.get(String(toy.id))||0) > availableCount){
        throw new Error('Er zijn tegelijk meer ontleningen voor "' + toy.naam + '" dan er stuks beschikbaar zijn.');
      }
    });
  }
  function setCloudSyncError(message){
    cloudWritesEnabled = false;
    cloudSyncError = message;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = null;
    if(startupStatus === 'ready') updateCloudSyncErrorBanner();
  }
  function scheduleCloudSync(){
    if(!state.config.sheetsUrl || !cloudWritesEnabled || cloudSyncError) return;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(()=>{
      cloudSyncTimer = null;
      cloudSyncQueue = cloudSyncQueue
        .then(()=>pushToSheets(state.config.sheetsUrl))
        .catch(e=>{ console.error('kon niet synchroniseren met Google Sheets', e); });
    }, CLOUD_SYNC_DEBOUNCE_MS);
  }
  async function pushToSheets(url){
    if(!cloudWritesEnabled || cloudSyncError) throw new Error('Synchronisatie is gepauzeerd.');
    try{
      cloudSyncing = true;
      for(let attempt=0; attempt<3; attempt++){
        if(!cloudWritesEnabled || cloudSyncError) throw new Error('Synchronisatie is gepauzeerd.');
        const expectedRevision = cloudRevision;
        const snapshot = cloneValue(state);
        const base = cloneValue(cloudBaseState || cloudDataFromState(snapshot));
        const body = JSON.stringify({ appVersion: APP_VERSION, expectedRevision: expectedRevision, state: snapshot });
        let result = null;
        let latest = null;
        let postError = null;
        try{
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // vermijdt een CORS-preflight richting Apps Script
            body: body
          });
          if(!res.ok) throw new Error('serverfout bij opslaan (' + res.status + ')');
          result = await res.json();
        }catch(e){
          postError = e;
          // Apps Script kan de opslag afronden terwijl de browser de POST-respons niet kan lezen.
          latest = await fetchFromSheets(url);
          if(latest._revision === expectedRevision + 1 &&
              valuesEqual(cloudDataFromState(latest), cloudDataFromState(snapshot))){
            cloudRevision = latest._revision;
            cloudBaseState = cloudDataFromState(snapshot);
            return;
          }
        }

        if(result && result.updateRequired){
          const error = new Error('Deze app-versie is verouderd. Werk de app bij om verder te gaan.');
          error.code = 'app_update_required';
          error.requiredAppVersion = result.requiredAppVersion;
          throw error;
        }

        if(result && result.conflict){
          latest = await fetchFromSheets(url);
        } else if(result && (!result.ok || !Number.isInteger(result.revision))){
          throw new Error('De server heeft het opslaan niet bevestigd. Controleer de Apps Script-versie.');
        } else if(result){
          cloudRevision = result.revision;
          cloudBaseState = cloudDataFromState(snapshot);
          return;
        }

        if(!latest || latest._revision <= expectedRevision){
          throw new Error('De server kon de opslag niet bevestigen: ' + (postError ? postError.message : 'revisieconflict.'));
        }
        if(!isValidSheetsState(latest)) throw new Error('De gedeelde database bevat geen volledige gegevens.');

        const remoteState = {
          config: {...state.config, ...(latest.config||{}), sheetsUrl: url},
          students: latest.students,
          toys: latest.toys,
          loans: latest.loans,
          activeBeheerders: Array.isArray(latest.activeBeheerders) ? latest.activeBeheerders : []
        };
        state = mergeCloudStates(base, state, remoteState, url);
        saveStateLocally();
        cloudRevision = latest._revision;
        cloudBaseState = cloudDataFromState(remoteState);
        render();
        toast('Gelijktijdige wijzigingen samengevoegd; opnieuw opslaan…');
        if(attempt === 2){
          throw new Error('Er zijn te veel gelijktijdige wijzigingen om automatisch op te slaan. Je wijzigingen zijn lokaal bewaard; download een back-up en laad daarna de nieuwste gedeelde gegevens.');
        }
      }
    }catch(e){
      setCloudSyncError(e.message || 'Onbekende synchronisatiefout.');
      if(e.code === 'app_update_required'){
        startupStatus = 'update-required';
        startupUpdateVersion = e.requiredAppVersion;
        startupError = e.message;
        render();
      }
      throw e;
    }finally{
      cloudSyncing = false;
    }
  }
  async function fetchFromSheets(url, sinceRevision){
    if(Number.isInteger(sinceRevision)){
      const requestUrl = new URL(url);
      requestUrl.searchParams.set('since', String(sinceRevision));
      url = requestUrl.toString();
    }
    const res = await fetch(url, { method:'GET', cache:'no-store' });
    if(!res.ok) throw new Error('serverfout bij ophalen (' + res.status + ')');
    const json = await res.json();
    if(!json || typeof json !== 'object') throw new Error('ongeldig antwoord');
    if(json.protocol !== 1 || !Number.isInteger(json.revision) || typeof json.empty !== 'boolean'){
      throw new Error('De Apps Script-backend moet worden bijgewerkt voordat veilige synchronisatie kan worden gebruikt.');
    }
    if(typeof json.requiredAppVersion !== 'string' || !/^\d+(\.\d+)*$/.test(json.requiredAppVersion)){
      throw new Error('De Apps Script-backend moet worden bijgewerkt voordat app-versies kunnen worden gecontroleerd.');
    }
    if(compareVersions(APP_VERSION, json.requiredAppVersion) < 0){
      const error = new Error('Deze app-versie is verouderd. Werk de app bij om verder te gaan.');
      error.code = 'app_update_required';
      error.requiredAppVersion = json.requiredAppVersion;
      throw error;
    }
    if(json.unchanged === true){
      return {
        _unchanged: true,
        _empty: false,
        _revision: json.revision,
        _requiredAppVersion: json.requiredAppVersion
      };
    }
    if(json.empty) return {
      _empty: true,
      _revision: json.revision,
      _requiredAppVersion: json.requiredAppVersion
    };
    if(!json.state || typeof json.state !== 'object') throw new Error('De gedeelde database bevat geen geldige gegevens.');
    return {...json.state, _empty: false, _revision: json.revision, _requiredAppVersion: json.requiredAppVersion};
  }
  function compareVersions(left, right){
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for(let i=0; i<Math.max(a.length,b.length); i++){
      const difference = (a[i]||0) - (b[i]||0);
      if(difference) return difference;
    }
    return 0;
  }
  function isValidSheetsState(remote){
    return !remote._empty && Array.isArray(remote.students) &&
      Array.isArray(remote.toys) && Array.isArray(remote.loans);
  }
  async function loadSheetsState(url, allowEmptyInitialization){
    const remote = await fetchFromSheets(url);
    if(!isValidSheetsState(remote)){
      if(!allowEmptyInitialization || !remote._empty){
        throw new Error('De gedeelde database bevat geen volledige gegevens.');
      }
      if(!window.confirm('De gedeelde Google Sheet is leeg. Wil je deze nu initialiseren met de gegevens die lokaal op dit toestel staan? Doe dit alleen als je zeker weet dat dit het juiste, nieuwe schoolbestand is.')){
        throw new Error('Initialisatie van de lege gedeelde database is geannuleerd.');
      }
      cloudRevision = remote._revision;
      cloudWritesEnabled = true;
      cloudSyncError = '';
      await pushToSheets(url);
      return;
    }
    state = {
      config: {...state.config, ...(remote.config||{}), sheetsUrl: url},
      students: remote.students,
      toys: remote.toys,
      activeBeheerders: Array.isArray(remote.activeBeheerders) ? remote.activeBeheerders : [],
      loans: remote.loans
    };
    cloudRevision = remote._revision;
    cloudBaseState = cloudDataFromState(state);
    cloudWritesEnabled = true;
    cloudSyncError = '';
  }

  async function connectSheets(url){
    url = url.trim();
    if(!url){ toast('Geef een geldige Apps Script-URL in.'); return; }
    try{
      const remote = await fetchFromSheets(url);
      if(remote._empty){
        if(!window.confirm('De gedeelde Google Sheet is leeg. Wil je deze nu initialiseren met de gegevens die lokaal op dit toestel staan? Doe dit alleen als je zeker weet dat dit het juiste, nieuwe schoolbestand is.')){
          return;
        }
        state.config.sheetsUrl = url;
        cloudRevision = remote._revision;
        cloudBaseState = cloudDataFromState(state);
        cloudWritesEnabled = true;
        cloudSyncError = '';
        saveStateLocally();
        await pushToSheets(url);
      } else {
        if(!isValidSheetsState(remote)) throw new Error('De gedeelde database bevat geen volledige gegevens.');
        state = {
          config: {...state.config, ...(remote.config||{}), sheetsUrl: url},
          students: remote.students,
          toys: remote.toys,
          activeBeheerders: Array.isArray(remote.activeBeheerders) ? remote.activeBeheerders : [],
          loans: remote.loans
        };
        cloudRevision = remote._revision;
        cloudBaseState = cloudDataFromState(state);
        cloudWritesEnabled = true;
        cloudSyncError = '';
        saveStateLocally();
      }
      toast('Verbonden met Google Sheets.');
      render();
      startPolling();
    }catch(e){
      console.error('kon niet verbinden met Google Sheets', e);
      toast('Kon geen verbinding maken: ' + e.message);
    }
  }
  function disconnectSheets(){
    state.config.sheetsUrl = '';
    cloudBaseState = null;
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
    if(typeof XLSX === 'undefined') throw new Error('Excel is niet beschikbaar. Verbind met internet en herlaad de app.');
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
      if(typeof XLSX === 'undefined') throw new Error('Excel is niet beschikbaar. Verbind met internet en herlaad de app.');
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
    if(state.config.sheetsUrl) throw new Error('Ontkoppel eerst Google Sheets voordat je Excel als gegevensbron gebruikt.');
    if(typeof XLSX === 'undefined') throw new Error('Excel is niet beschikbaar. Verbind met internet en herlaad de app.');
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
    if(state.config.sheetsUrl){ toast('Ontkoppel eerst Google Sheets voordat je Excel als gegevensbron gebruikt.'); return; }
    if(typeof XLSX === 'undefined'){ toast('Excel is niet beschikbaar. Verbind met internet en herlaad de app.'); return; }
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
    if(state.config.sheetsUrl){ toast('Ontkoppel eerst Google Sheets voordat je Excel als gegevensbron gebruikt.'); return; }
    if(typeof XLSX === 'undefined'){ toast('Excel is niet beschikbaar. Verbind met internet en herlaad de app.'); return; }
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
  // 7. LIVE VERVERSEN (multi-toestel polling)
  // ==========================================================================
  const POLL_INTERVAL_MS = 2000;
  let pollTimer = null;
  let pollInFlight = false;
  let visibilityListenerAttached = false;
  function snapshotKey(){
    return JSON.stringify({ config: state.config, students: state.students, toys: state.toys, loans: state.loans, activeBeheerders: state.activeBeheerders });
  }
  function startPolling(){
    if(pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if(!state.config.ingesteld) return;
    if(!state.config.sheetsUrl && !fileHandleConnected()) return;
    if(!visibilityListenerAttached){
      document.addEventListener('visibilitychange', ()=>{
        if(document.visibilityState === 'visible') pollSharedState();
      });
      visibilityListenerAttached = true;
    }
    pollSharedState();
    pollTimer = setInterval(pollSharedState, POLL_INTERVAL_MS);
  }
  async function pollSharedState(){
    if(pollInFlight || document.visibilityState === 'hidden') return;
    // niet verversen terwijl iemand middenin een invoerveld typt, dat zou het overschrijven
    const active = document.activeElement;
    if(cloudSyncing || cloudSyncTimer || cloudSyncError) return;
    if(active && (active.tagName==='INPUT' || active.tagName==='TEXTAREA')) return;
    pollInFlight = true;
    const before = snapshotKey();
    try{
      if(state.config.sheetsUrl){
        const remote = await fetchFromSheets(state.config.sheetsUrl, cloudRevision);
        if(remote._unchanged) return;
        if(!isValidSheetsState(remote)) throw new Error('De gedeelde database bevat geen volledige gegevens.');
        if(snapshotKey() !== before) return;
        cloudRevision = remote._revision;
        state.config = {...state.config, ...(remote.config||{}), sheetsUrl: state.config.sheetsUrl};
        state.students = remote.students; state.toys = remote.toys;
        state.loans = remote.loans;
        state.activeBeheerders = Array.isArray(remote.activeBeheerders) ? remote.activeBeheerders : [];
        cloudBaseState = cloudDataFromState(state);
      } else if(fileHandleConnected()){
        await loadFromFile(fileHandle);
      }
      if(snapshotKey() !== before){
        if(state.config.sheetsUrl){
          saveLocalData('config', state.config);
          saveLocalData('students', state.students); saveLocalData('toys', state.toys);
          saveLocalData('loans', state.loans); saveLocalData('activeBeheerders', state.activeBeheerders);
        }
        render();
      }
    }catch(e){
      if(e.code === 'app_update_required'){
        clearInterval(pollTimer);
        startupError = e.message;
        startupUpdateVersion = e.requiredAppVersion;
        startupStatus = 'update-required';
        render();
      }
    }finally{
      pollInFlight = false;
    }
  }

  // ==========================================================================
  // 8. WHITELABEL: CONFIGURATIE VIA ONDERTEKENDE LINK
  // ==========================================================================
  // LET OP: verander deze sleutel voor jullie eigen uitrol (moet identiek zijn aan die in linkgenerator.html).
  // Dit is een client-side controle die per-ongeluk-aangepaste of los-verzonnen links tegenhoudt — het is
  // GEEN waterdichte beveiliging, want deze sleutel staat mee in de publiek gehoste broncode (zie "Paginabron
  // weergeven"). Voor echte bescherming is een server-kant validatie nodig (optie B, later).
  const LINK_SECRET = 'dgTuyMFUMQCdL7paz9bF9Mb8N5YwJYrsuOv2G0bAGrU';

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
    if(startupStatus !== 'ready'){
      app.appendChild(viewStartupGate());
      return;
    }
    if(!state.config.ingesteld){
      if(linkConfigInvalid) app.appendChild(viewInvalidLink());
      else app.appendChild(pendingUrlConfig ? viewConfirmUrlConfig() : viewSetup());
      return;
    }
    app.appendChild(topbar());
    if(cloudSyncError) app.appendChild(viewCloudSyncError());
    let body;
    if(route === 'home') body = viewHome();
    else if(route === 'beheerder') body = viewBeheerder();
    else if(route === 'overzicht') body = viewOverzicht();
    else if(route === 'admin') body = viewAdmin();
    app.appendChild(body);
  }

  function viewCloudSyncError(){
    const card = el('div','card');
    card.className = 'card cloud-sync-error';
    card.style.borderColor = 'var(--overdue)';
    card.appendChild(el('h2','', 'Synchronisatie gepauzeerd'));
    card.appendChild(el('p','muted','Deze computer kon niet veilig opslaan. Je wijzigingen blijven lokaal bewaard, maar zijn nog niet gedeeld. Download eerst een back-up of laad daarna de nieuwste gedeelde versie.'));
    const errorMessage = el('p','muted');
    errorMessage.textContent = cloudSyncError;
    card.appendChild(errorMessage);
    const backupBtn = document.createElement('button');
    backupBtn.className = 'secondary';
    backupBtn.textContent = 'Back-up van deze computer downloaden';
    backupBtn.onclick = exportBackup;
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'primary';
    reloadBtn.style.marginLeft = '8px';
    reloadBtn.textContent = 'Nieuwste gedeelde gegevens laden';
    reloadBtn.onclick = reloadLatestCloudData;
    card.appendChild(backupBtn);
    card.appendChild(reloadBtn);
    return card;
  }

  function updateCloudSyncErrorBanner(){
    const app = document.getElementById('app');
    const existing = app.querySelector('.cloud-sync-error');
    if(existing) existing.remove();
    if(cloudSyncError && state.config.ingesteld && app.firstElementChild){
      app.insertBefore(viewCloudSyncError(), app.children[1] || null);
    }
  }

  async function reloadLatestCloudData(){
    if(!window.confirm('Dit vervangt de lokale gegevens op deze computer door de nieuwste gedeelde versie. Download eerst een back-up als je lokale wijzigingen wilt bewaren. Doorgaan?')){
      return;
    }
    try{
      const remote = await fetchFromSheets(state.config.sheetsUrl);
      if(!isValidSheetsState(remote)) throw new Error('De gedeelde database bevat geen volledige gegevens.');
      state = {
        config: {...state.config, ...(remote.config||{}), sheetsUrl: state.config.sheetsUrl},
        students: remote.students,
        toys: remote.toys,
        activeBeheerders: Array.isArray(remote.activeBeheerders) ? remote.activeBeheerders : [],
        loans: remote.loans
      };
      cloudRevision = remote._revision;
      cloudBaseState = cloudDataFromState(state);
      saveStateLocally();
      cloudSyncError = '';
      cloudWritesEnabled = true;
      render();
      startPolling();
    }catch(e){
      console.error('kon niet laden van de nieuwste Google Sheets-gegevens', e);
      cloudSyncError = e.message || 'De nieuwste gedeelde gegevens konden niet worden geladen.';
      updateCloudSyncErrorBanner();
    }
  }

  function viewStartupGate(){
    const wrap = el('div');
    const card = el('div','card lockscreen');
    const updateRequired = startupStatus === 'update-required';
    card.appendChild(el('div','icon',startupStatus === 'loading' ? '⏳' : '⚠️'));
    card.appendChild(el('h1','page-title',startupStatus === 'loading' ? 'Gegevens laden…' : (updateRequired ? 'App-update vereist' : 'Geen verbinding met de gedeelde gegevens')));
    card.appendChild(el('p','muted',startupStatus === 'loading'
      ? 'De app wacht tot de gegevens uit Google Sheets volledig zijn geladen.'
      : (updateRequired
        ? 'Deze versie is verouderd en blijft gesloten om veilig gebruik te garanderen. Werk de app bij en probeer opnieuw.'
        : 'De gegevens zijn niet volledig geladen. De app blijft gesloten zodat er niets wordt overschreven. Controleer je internetverbinding en probeer opnieuw.')));
    if(updateRequired){
      card.appendChild(el('p','muted','Huidige versie: ' + APP_VERSION + ' · Vereist: ' + startupUpdateVersion));
      const updateBtn = document.createElement('button');
      updateBtn.className = 'primary';
      updateBtn.style.width = '100%';
      updateBtn.textContent = 'App bijwerken en opnieuw laden';
      updateBtn.onclick = updateApp;
      card.appendChild(updateBtn);
      if(startupUpdateError){
        const updateError = el('p','muted');
        updateError.textContent = startupUpdateError;
        card.appendChild(updateError);
      }
    } else if(startupStatus === 'error'){
      const retryBtn = document.createElement('button');
      retryBtn.className = 'primary';
      retryBtn.style.width = '100%';
      retryBtn.textContent = 'Opnieuw proberen';
      retryBtn.onclick = retryStartupLoad;
      card.appendChild(retryBtn);
      if(startupError){
        const errorMessage = el('p','muted');
        errorMessage.textContent = startupError;
        card.appendChild(errorMessage);
      }
    }
    wrap.appendChild(card);
    return wrap;
  }

  async function updateApp(){
    startupUpdateError = '';
    try{
      const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if(registration){
        await registration.update();
        const worker = registration.installing || registration.waiting;
        if(worker){
          await new Promise(resolve=>{
            if(worker.state === 'activated' || worker.state === 'redundant') return resolve();
            const timeout = setTimeout(resolve, 10000);
            worker.addEventListener('statechange', ()=>{
              if(worker.state === 'activated' || worker.state === 'redundant'){
                clearTimeout(timeout);
                resolve();
              }
            });
          });
        }
      }
      window.location.reload();
    }catch(e){
      console.error('kon app-update niet controleren', e);
      startupUpdateError = 'De update kon niet worden opgehaald. Controleer je internetverbinding en probeer opnieuw.';
      render();
    }
  }

  function setStartupLoadError(error){
    startupError = error.message || 'Onbekende fout bij het laden.';
    if(error.code === 'app_update_required'){
      startupStatus = 'update-required';
      startupUpdateVersion = error.requiredAppVersion;
    } else {
      startupStatus = 'error';
    }
  }

  async function retryStartupLoad(){
    startupStatus = 'loading';
    startupError = '';
    render();
    try{
      await loadSheetsState(state.config.sheetsUrl, startupCanInitializeEmpty);
      startupCanInitializeEmpty = false;
      startupStatus = 'ready';
      render();
      startPolling();
    }catch(e){
      console.error('kon niet laden van Google Sheets', e);
      setStartupLoadError(e);
      render();
    }
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
    [
      ['Schoolnaam:', pendingUrlConfig.schoolNaam],
      ['Pincode:', pendingUrlConfig.pin],
      ['Gedeelde opslag:', pendingUrlConfig.sheetsUrl ? 'gekoppeld — ' + pendingUrlConfig.sheetsUrl : 'niet gekoppeld, enkel lokaal op dit toestel']
    ].forEach(([label, value])=>{
      const line = document.createElement('div');
      const strong = document.createElement('b');
      strong.textContent = label + ' ';
      line.appendChild(strong);
      line.appendChild(document.createTextNode(value));
      box.appendChild(line);
    });
    card.appendChild(box);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'primary'; confirmBtn.style.width = '100%'; confirmBtn.style.marginTop = '14px';
    confirmBtn.textContent = 'Klopt, bevestigen en starten';
    confirmBtn.onclick = async ()=>{
      state.config = { pin: pendingUrlConfig.pin, schoolNaam: pendingUrlConfig.schoolNaam, sheetsUrl: pendingUrlConfig.sheetsUrl, ingesteld: true };
      setData('config', state.config);
      history.replaceState(null, '', window.location.pathname + window.location.hash);
      if(state.config.sheetsUrl){
        startupStatus = 'loading';
        startupCanInitializeEmpty = true;
        render();
        try{
          await loadSheetsState(state.config.sheetsUrl, true);
          startupCanInitializeEmpty = false;
          startupStatus = 'ready';
        }catch(e){
          console.error('kon niet laden van Google Sheets', e);
          setStartupLoadError(e);
        }
      } else {
        startupStatus = 'ready';
      }
      pendingUrlConfig = null;
      if(startupStatus === 'ready') toast('Welkom, ' + state.config.schoolNaam + '!');
      render();
      if(startupStatus === 'ready') startPolling();
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
    const brand = el('div', 'brand');
    brand.appendChild(el('span', 'crate'));
    brand.appendChild(document.createTextNode(' Speelgoedotheek'));
    if(state.config.schoolNaam){
      const school = el('span', 'badge', state.config.schoolNaam);
      school.style.verticalAlign = 'middle';
      brand.appendChild(school);
    }
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
    const bannerLabel = document.createElement('span');
    bannerLabel.textContent = '🔓 Kast open — beheerder(s): ' + state.activeBeheerders.map(studentName).join(', ');
    banner.appendChild(bannerLabel);
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
        appendTextCell(tr, toy ? toy.naam : '?');
        appendTextCell(tr, studentName(l.studentId));
        const sinceCell = appendTextCell(tr, fmtDate(l.uitDatum));
        if(overdue){
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.style.background = 'var(--overdue)';
          badge.style.color = '#fff';
          badge.textContent = ' te lang uit';
          sinceCell.appendChild(badge);
        }
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
        const name = el('div', 'name', t.naam);
        const details = el('div', 'who', avail+' / '+aantal+' beschikbaar'+(meta?' · '+meta:''));
        if(wieRegel){
          details.appendChild(document.createElement('br'));
          details.appendChild(document.createTextNode(wieRegel));
        }
        slot.appendChild(name);
        slot.appendChild(details);
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
        appendTextCell(tr, toy ? toy.naam : '?');
        appendTextCell(tr, studentName(l.studentId));
        appendTextCell(tr, fmtDate(l.uitDatum));
        const statusCell = document.createElement('td');
        if(l.teruggegeven){
          statusCell.textContent = 'Terug ('+fmtDate(l.terugDatum)+')';
        } else {
          const status = document.createElement('b');
          status.textContent = isOverdue(l) ? '⚠️ Te lang uit' : 'Nog buiten';
          if(isOverdue(l)) status.style.color = 'var(--overdue)';
          statusCell.appendChild(status);
        }
        tr.appendChild(statusCell);
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
        appendTextCell(tr, s.naam);
        appendTextCell(tr, s.leerjaar||'-');
        appendTextCell(tr, s.klasgroep||'-');
        appendTextCell(tr, s.kanBeheerder?'✅':'—');
        appendTextCell(tr, s.actief===false?'Inactief':'Actief');
        appendTextCell(tr, s.opmerking||'');
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
        appendTextCell(tr, t.naam);
        appendTextCell(tr, t.categorie||'-');
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
        appendTextCell(tr, toy ? toy.naam : '(verwijderd)');
        appendTextCell(tr, studentName(l.studentId));
        appendTextCell(tr, beheerderNames(l.beheerderIdUit));
        appendTextCell(tr, fmtDate(l.uitDatum));
        const returnedCell = document.createElement('td');
        if(l.teruggegeven){
          returnedCell.textContent = fmtDate(l.terugDatum)+' (via '+beheerderNames(l.beheerderIdTerug)+')';
        } else {
          const notReturned = document.createElement('b');
          notReturned.textContent = 'nog buiten';
          returnedCell.appendChild(notReturned);
        }
        tr.appendChild(returnedCell);
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
    topToys.forEach(t=>{
      const tr=document.createElement('tr');
      appendTextCell(tr, t.naam);
      appendTextCell(tr, t.count);
      toyTbl.appendChild(tr);
    });
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
      const average = el('p');
      const averageValue = document.createElement('b');
      averageValue.textContent = label;
      average.appendChild(averageValue);
      average.appendChild(document.createTextNode(' gemiddeld, over ' + teruggegeven.length + ' teruggegeven ontleningen.'));
      durCard.appendChild(average);
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
    Object.entries(perLeerjaar).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{
      const tr=document.createElement('tr');
      appendTextCell(tr, k);
      appendTextCell(tr, v);
      ljTbl.appendChild(tr);
    });
    leerjaarCard.appendChild(ljTbl);
    wrap.appendChild(leerjaarCard);

    return wrap;
  }

  function adminInstellingen(){
    const card = el('div','card');
    card.appendChild(el('h2','School & pincode'));
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

    const versionCard = el('div','card');
    versionCard.appendChild(el('h2','App-versie'));
    versionCard.appendChild(el('p','muted','Deze computer gebruikt versie ' + APP_VERSION + '.'));

    const sheetsCard = el('div','card');
    sheetsCard.appendChild(el('h2','🌐 Gedeelde online opslag (Google Sheets)'));
    sheetsCard.appendChild(el('p','muted','Werkt op elk toestel — ook tablets en Chromebooks — en houdt alle PC\'s meteen up-to-date. Vereist eenmalig een gratis Google Sheet + Apps Script-koppeling (zie README).'));
    if(state.config.sheetsUrl){
      const connected = el('div');
      connected.appendChild(el('b','','✅ Gekoppeld'));
      connected.appendChild(document.createElement('br'));
      connected.appendChild(el('span','muted',state.config.sheetsUrl));
      sheetsCard.appendChild(connected);
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
      fileCard.appendChild(el('p','muted','Koppel de app aan een .xlsx-bestand dat je bewaart in je OneDrive-map van de scholengroep. Elke wijziging wordt automatisch weggeschreven — jullie eigen OneDrive zorgt dan voor de back-up naar de cloud van de scholengroep, zonder dat deze app zelf iets online stuurt. Ontkoppel eerst Google Sheets als je Excel als gegevensbron wilt gebruiken.'));
      const xlsxUnavailable = typeof XLSX === 'undefined';
      if(xlsxUnavailable){
        fileCard.appendChild(el('div','empty','Excel-functies zijn momenteel niet beschikbaar. De Excel-bibliotheek wordt via internet geladen; verbind met internet en herlaad de app om een Excel-bestand te koppelen of bij te werken. De app blijft bruikbaar, maar wijzigingen worden intussen niet naar een gekoppeld Excel-bestand geschreven.'));
      }
      const statusRow = el('div','row');
      if(fileHandleConnected()){
        const status = el('div');
        status.appendChild(el('b','','✅ Gekoppeld aan:'));
        status.appendChild(document.createTextNode(' ' + fileHandle.name));
        statusRow.appendChild(status);
      } else if(fileHandle){
        const status = el('div');
        status.appendChild(el('b','','⚠️ Verbinding verbroken'));
        status.appendChild(document.createTextNode(' met ' + fileHandle.name + ' — klik om te herstellen.'));
        statusRow.appendChild(status);
      } else {
        const status = el('div');
        status.appendChild(el('b','','Niet gekoppeld'));
        status.appendChild(document.createTextNode(' — data zit enkel lokaal in deze browser.'));
        statusRow.appendChild(status);
      }
      fileCard.appendChild(statusRow);
      statusRow.style.marginBottom = '14px';

      const btnRow = el('div','row');
      if(fileHandle && !fileHandleConnected()){
        const reconnectBtn = document.createElement('button'); reconnectBtn.className='primary'; reconnectBtn.textContent='🔄 Verbinding herstellen';
        reconnectBtn.disabled = xlsxUnavailable;
        reconnectBtn.onclick = async ()=>{
          if(typeof XLSX === 'undefined'){ toast('Excel is niet beschikbaar. Verbind met internet en herlaad de app.'); return; }
          if(state.config.sheetsUrl){ toast('Ontkoppel eerst Google Sheets voordat je Excel als gegevensbron gebruikt.'); return; }
          try{
            const perm = await fileHandle.requestPermission({mode:'readwrite'});
            if(perm==='granted'){ fileHandlePermGranted = true; await loadFromFile(fileHandle); toast('Verbinding hersteld.'); render(); startPolling(); }
            else toast('Toestemming geweigerd.');
          }catch(e){ toast('Kon de verbinding niet herstellen.'); }
        };
        btnRow.appendChild(reconnectBtn);
      }
      const newBtn = document.createElement('button'); newBtn.className='secondary'; newBtn.textContent='📁 Nieuw bestand aanmaken';
      newBtn.disabled = xlsxUnavailable;
      newBtn.onclick = ()=>linkNewFile();
      const existBtn = document.createElement('button'); existBtn.className='secondary'; existBtn.textContent='📂 Bestaand bestand kiezen';
      existBtn.disabled = xlsxUnavailable;
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

    const wrap = el('div'); wrap.appendChild(card); wrap.appendChild(versionCard); wrap.appendChild(sheetsCard); wrap.appendChild(fileCard); wrap.appendChild(backupCard); wrap.appendChild(resetCard);
    return wrap;
  }

  // ==========================================================================
  // 13. OPSTART
  // ==========================================================================
  (async function init(){
    loadAll();
    render();
    await applyUrlConfig();
    if(state.config.ingesteld && state.config.sheetsUrl){
      try{
        await loadSheetsState(state.config.sheetsUrl, false);
        startupStatus = 'ready';
      }catch(e){
        console.error('kon niet laden van Google Sheets', e);
        setStartupLoadError(e);
      }
    } else {
      startupStatus = 'ready';
    }
    if(!state.config.sheetsUrl) await tryReconnectOnStartup();
    render();
    startPolling();
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('./sw.js').catch(()=>{});
    }
  })();

})();
