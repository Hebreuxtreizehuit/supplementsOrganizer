/* Supplements Organizer (offline PWA)
   - Supplements library with photo, notes, tags
   - Daily planner with time slots
   - Rule-based “take together” checker (user-defined, non-medical)
   - Weather (Open-Meteo) + local time (device timezone)
   - Calendar appointments + notes (timezone-aware)
   - Export / Import JSON backups (includes appointments)
*/

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STORE_KEY   = "supporg.v7";
const WEATHER_KEY = "supporg.weather.v7";
const CITY_KEY    = "supporg.city.v7";

const DEFAULT_CITY = "Toronto";

const state = loadState();

let currentDate = todayISO();
let selectedSlotId = null;
let editingSuppId = null;

let deferredPrompt = null;

// -------------------- Small helpers --------------------
function uid(prefix="id"){
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function pad2(n){ return String(n).padStart(2,"0"); }

function todayISO(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function escapeHTML(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function fileToDataURL(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function localTZ(){
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// -------------------- State --------------------
function loadState(){
  const raw = localStorage.getItem(STORE_KEY);
  if(raw){
    try{
      const obj = JSON.parse(raw);
      // normalize missing fields (safe upgrades)
      obj.supplements   = Array.isArray(obj.supplements) ? obj.supplements : [];
      obj.slots         = Array.isArray(obj.slots) ? obj.slots : [];
      obj.plans         = obj.plans && typeof obj.plans === "object" ? obj.plans : {};
      obj.rules         = Array.isArray(obj.rules) ? obj.rules : [];
      obj.appointments  = Array.isArray(obj.appointments) ? obj.appointments : [];
      if(obj.slots.length === 0){
        obj.slots = [
          {id: uid("slot"), name:"Morning"},
          {id: uid("slot"), name:"Midday"},
          {id: uid("slot"), name:"Evening"},
          {id: uid("slot"), name:"Bedtime"},
        ];
      }
      return obj;
    }catch(e){}
  }

  return {
    supplements: [],
    slots: [
      {id: uid("slot"), name:"Morning"},
      {id: uid("slot"), name:"Midday"},
      {id: uid("slot"), name:"Evening"},
      {id: uid("slot"), name:"Bedtime"},
    ],
    plans: {},
    rules: [],
    appointments: [] // ✅ calendar data
  };
}

function saveState(){
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function ensurePlan(dateISO){
  if(!state.plans[dateISO]) state.plans[dateISO] = {};
  for(const s of state.slots){
    if(!state.plans[dateISO][s.id]) state.plans[dateISO][s.id] = [];
  }
}

// -------------------- Network + Install --------------------
function refreshNetBadge(){
  const badge = $("#netBadge");
  const on = navigator.onLine;
  badge.textContent = on ? "Online" : "Offline";
  badge.style.borderColor = on ? "rgba(53,208,127,.45)" : "rgba(159,176,194,.35)";
}

window.addEventListener("online", refreshNetBadge);
window.addEventListener("offline", refreshNetBadge);

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("#installBtn").classList.remove("hidden");
});

$("#installBtn").addEventListener("click", async () => {
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $("#installBtn").classList.add("hidden");
});

// -------------------- Tabs --------------------
function wireTabs(){
  $$(".tab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      $$(".tab").forEach(b=>b.classList.remove("active"));
      $$(".tabPane").forEach(p=>p.classList.remove("active"));
      btn.classList.add("active");
      const pane = $(`#tab-${btn.dataset.tab}`);
      if(pane) pane.classList.add("active");
    });
  });
}

// -------------------- Date picker + Print --------------------
function wireDateAndPrint(){
  $("#datePick").value = currentDate;

  $("#datePick").addEventListener("change", (e)=>{
    currentDate = e.target.value || todayISO();
    ensurePlan(currentDate);
    selectedSlotId = null;
    renderAll();
  });

  $("#printBtn").addEventListener("click", ()=> window.print());
}

// -------------------- Export / Import (includes appointments) --------------------
function wireExportImport(){
  $("#exportBtn").addEventListener("click", ()=>{
    const blob = new Blob([JSON.stringify(state, null, 2)], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `supplements-organizer-backup_${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#importInput").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if(!file) return;

    try{
      const text = await file.text();
      const obj = JSON.parse(text);

      // light validation
      if(!obj || !Array.isArray(obj.supplements) || !Array.isArray(obj.slots) || !obj.plans || !Array.isArray(obj.rules)){
        alert("That file doesn't look like a valid backup for this app.");
        e.target.value = "";
        return;
      }

      // replace in-place
      state.supplements  = obj.supplements;
      state.slots        = obj.slots;
      state.plans        = obj.plans;
      state.rules        = obj.rules;
      state.appointments = Array.isArray(obj.appointments) ? obj.appointments : [];

      ensurePlan(currentDate);
      saveState();
      renderAll();
      renderCalendar();
      alert("Import complete.");
    }catch(err){
      alert("Import failed. Make sure you selected a valid JSON backup.");
    }finally{
      e.target.value = "";
    }
  });
}

// -------------------- Planner: Slots --------------------
function slotName(id){
  return state.slots.find(s=>s.id===id)?.name || "Slot";
}

function suppById(id){
  return state.supplements.find(s=>s.id===id) || null;
}

function wireSlots(){
  $("#addSlotBtn").addEventListener("click", ()=>{
    const name = prompt("Name of the new time slot (e.g., After School):");
    if(!name) return;
    state.slots.push({id: uid("slot"), name: name.trim()});
    ensurePlan(currentDate);
    saveState();
    renderAll();
  });
}

function renderSlots(){
  ensurePlan(currentDate);
  const box = $("#slotsList");
  box.innerHTML = "";

  for(const s of state.slots){
    const count = state.plans[currentDate][s.id]?.length || 0;
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div>
        <strong>${escapeHTML(s.name)}</strong>
        <div class="meta">${count} item(s)</div>
      </div>
      <div class="right">
        <button class="btnSmall" data-act="select">Open</button>
        <button class="btnSmall" data-act="rename">Rename</button>
        <button class="btnSmall dangerBtn" data-act="delete">Delete</button>
      </div>
    `;

    el.querySelector('[data-act="select"]').addEventListener("click", ()=>{
      selectedSlotId = s.id;
      renderSlotDetails();
    });

    el.querySelector('[data-act="rename"]').addEventListener("click", ()=>{
      const name = prompt("Rename slot:", s.name);
      if(!name) return;
      s.name = name.trim();
      saveState();
      renderSlots();
      if(selectedSlotId===s.id) renderSlotDetails();
    });

    el.querySelector('[data-act="delete"]').addEventListener("click", ()=>{
      if(!confirm(`Delete slot "${s.name}"? (Items inside will be removed from daily plans, but supplements remain.)`)) return;

      state.slots = state.slots.filter(x=>x.id!==s.id);

      for(const d of Object.keys(state.plans)){
        if(state.plans[d] && state.plans[d][s.id]) delete state.plans[d][s.id];
      }

      if(selectedSlotId===s.id) selectedSlotId = null;
      ensurePlan(currentDate);
      saveState();
      renderAll();
    });

    box.appendChild(el);
  }
}

function renderSlotDetails(){
  const meta = $("#slotMeta");
  const panel = $("#slotDetails");

  if(!selectedSlotId){
    meta.textContent = "Select a slot";
    panel.classList.add("empty");
    panel.innerHTML = `<div class="muted">Choose a slot on the left to add supplements into it.</div>`;
    return;
  }

  panel.classList.remove("empty");
  meta.textContent = `${slotName(selectedSlotId)} • ${currentDate}`;

  ensurePlan(currentDate);
  const chosenIds = state.plans[currentDate][selectedSlotId] || [];
  const available = state.supplements.slice().sort((a,b)=>a.name.localeCompare(b.name));

  panel.innerHTML = `
    <div class="formRow">
      <label class="label">Add supplement to this slot</label>
      <select id="slotAddSelect" class="input"></select>
    </div>
    <div class="row gap">
      <button id="slotAddBtn" class="btnSmall">Add</button>
      <button id="slotClearBtn" class="ghost btnSmall">Clear Slot</button>
    </div>
    <div class="divider"></div>
    <div id="slotItems" class="list"></div>
  `;

  const sel = panel.querySelector("#slotAddSelect");
  sel.innerHTML = `<option value="">— choose —</option>` +
    available.map(s=>`<option value="${s.id}">${escapeHTML(s.name)}</option>`).join("");

  panel.querySelector("#slotAddBtn").addEventListener("click", ()=>{
    const id = sel.value;
    if(!id) return;
    ensurePlan(currentDate);
    const arr = state.plans[currentDate][selectedSlotId];
    if(!arr.includes(id)) arr.push(id);
    saveState();
    renderSlots();
    renderSlotDetails();
  });

  panel.querySelector("#slotClearBtn").addEventListener("click", ()=>{
    if(!confirm("Clear all items from this slot for this date?")) return;
    ensurePlan(currentDate);
    state.plans[currentDate][selectedSlotId] = [];
    saveState();
    renderSlots();
    renderSlotDetails();
  });

  const itemsBox = panel.querySelector("#slotItems");
  if(chosenIds.length===0){
    itemsBox.innerHTML = `<div class="muted">No supplements added to this slot yet.</div>`;
    return;
  }

  for(const id of chosenIds){
    const s = suppById(id);
    if(!s) continue;

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div>
        <strong>${escapeHTML(s.name)}</strong>
        <div class="meta">${escapeHTML([s.dose, s.form].filter(Boolean).join(" • "))}</div>
      </div>
      <div class="right">
        <button class="btnSmall" data-act="edit">Edit</button>
        <button class="btnSmall dangerBtn" data-act="remove">Remove</button>
      </div>
    `;

    el.querySelector('[data-act="edit"]').addEventListener("click", ()=> openSuppModal(s.id));
    el.querySelector('[data-act="remove"]').addEventListener("click", ()=>{
      ensurePlan(currentDate);
      state.plans[currentDate][selectedSlotId] = state.plans[currentDate][selectedSlotId].filter(x=>x!==id);
      saveState();
      renderSlots();
      renderSlotDetails();
    });

    itemsBox.appendChild(el);
  }
}

// -------------------- Supplements list + modal --------------------
function renderTagsLine(s){
  const parts = [];
  if(s.defaultSlot) parts.push(`Default: ${s.defaultSlot}`);
  if(s.freq) parts.push(`Freq: ${s.freq}`);
  if((s.tags||[]).length) parts.push(`Tags: ${(s.tags||[]).join(", ")}`);
  return parts.length ? parts.join(" • ") : "—";
}

function wireSuppLibrary(){
  $("#search").addEventListener("input", renderSuppList);
  $("#newBtn").addEventListener("click", ()=> openSuppModal(null));
}

function renderSuppList(){
  const q = ($("#search").value || "").trim().toLowerCase();
  const box = $("#suppList");
  box.innerHTML = "";

  const list = state.supplements
    .filter(s=>{
      if(!q) return true;
      const hay = [s.name,s.dose,s.form,(s.notes||""),(s.tags||[]).join(",")].join(" ").toLowerCase();
      return hay.includes(q);
    })
    .sort((a,b)=>a.name.localeCompare(b.name));

  if(list.length===0){
    box.innerHTML = `<div class="muted">No supplements found. Click “+ Add” to create one.</div>`;
    renderRulePickers();
    renderCheckPicker();
    return;
  }

  for(const s of list){
    const card = document.createElement("div");
    card.className = "suppCard";

    const initials = (s.name || "?").split(/\s+/).slice(0,2).map(x=>x[0]?.toUpperCase()||"").join("");

    card.innerHTML = `
      <div class="thumb">${s.photoDataUrl ? `<img alt="" src="${s.photoDataUrl}">` : escapeHTML(initials)}</div>
      <div>
        <div class="suppTitle">${escapeHTML(s.name)}</div>
        <div class="suppSub">${escapeHTML([s.dose, s.form].filter(Boolean).join(" • "))}</div>
        <div class="tagline">${escapeHTML(renderTagsLine(s))}</div>
      </div>
      <div class="suppActions">
        <button class="btnSmall" data-act="addToDefault">Add to Slot</button>
        <button class="btnSmall" data-act="edit">Edit</button>
      </div>
    `;

    card.querySelector('[data-act="edit"]').addEventListener("click", ()=> openSuppModal(s.id));

    card.querySelector('[data-act="addToDefault"]').addEventListener("click", ()=>{
      const slot = state.slots.find(x=>x.name===s.defaultSlot) || state.slots[0];
      if(!slot){ alert("Create a slot first."); return; }
      ensurePlan(currentDate);
      const arr = state.plans[currentDate][slot.id];
      if(!arr.includes(s.id)) arr.push(s.id);
      saveState();
      renderSlots();
      if(selectedSlotId===slot.id) renderSlotDetails();
      alert(`Added to ${slot.name} for ${currentDate}.`);
    });

    box.appendChild(card);
  }

  renderRulePickers();
  renderCheckPicker();
}

const suppModal = $("#modal");

function wireSuppModal(){
  $("#closeModal").addEventListener("click", closeSuppModal);
  $("#cancelBtn").addEventListener("click", closeSuppModal);
  $("#saveBtn").addEventListener("click", saveSuppModal);
  $("#deleteBtn").addEventListener("click", deleteSuppModal);

  $("#m_photo").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if(!file) return;
    const dataUrl = await fileToDataURL(file);
    $("#m_preview").src = dataUrl;
    $("#m_preview").classList.remove("hidden");
    $("#m_previewEmpty").classList.add("hidden");
    $("#m_preview").dataset.dataUrl = dataUrl;
  });

  // click backdrop to close
  suppModal.addEventListener("click", (e)=>{
    if(e.target.id === "modal") closeSuppModal();
  });
}

function openSuppModal(suppId){
  editingSuppId = suppId;
  const isEdit = !!suppId;
  $("#modalTitle").textContent = isEdit ? "Edit Supplement" : "Add Supplement";
  $("#deleteBtn").classList.toggle("hidden", !isEdit);

  const s = isEdit ? suppById(suppId) : null;

  $("#m_name").value = s?.name || "";
  $("#m_dose").value = s?.dose || "";
  $("#m_form").value = s?.form || "";
  $("#m_notes").value = s?.notes || "";
  $("#m_tags").value = (s?.tags || []).join(", ");
  $("#m_defaultSlot").value = s?.defaultSlot || "";
  $("#m_freq").value = s?.freq || "daily";

  $("#m_photo").value = "";

  if(s?.photoDataUrl){
    $("#m_preview").src = s.photoDataUrl;
    $("#m_preview").classList.remove("hidden");
    $("#m_previewEmpty").classList.add("hidden");
    $("#m_preview").dataset.dataUrl = s.photoDataUrl;
  }else{
    $("#m_preview").classList.add("hidden");
    $("#m_previewEmpty").classList.remove("hidden");
    $("#m_preview").dataset.dataUrl = "";
  }

  suppModal.classList.remove("hidden");
}

function closeSuppModal(){
  suppModal.classList.add("hidden");
  editingSuppId = null;
}

function saveSuppModal(){
  const name = $("#m_name").value.trim();
  if(!name){
    alert("Name is required.");
    return;
  }

  const obj = {
    id: editingSuppId || uid("supp"),
    name,
    dose: $("#m_dose").value.trim(),
    form: $("#m_form").value.trim(),
    notes: $("#m_notes").value.trim(),
    tags: ($("#m_tags").value || "").split(",").map(x=>x.trim()).filter(Boolean),
    photoDataUrl: $("#m_preview").dataset.dataUrl || "",
    defaultSlot: $("#m_defaultSlot").value || "",
    freq: $("#m_freq").value || "daily"
  };

  if(editingSuppId){
    const idx = state.supplements.findIndex(x=>x.id===editingSuppId);
    if(idx>=0) state.supplements[idx] = obj;
  }else{
    state.supplements.push(obj);
    if(obj.defaultSlot){
      const slot = state.slots.find(x=>x.name===obj.defaultSlot);
      if(slot){
        ensurePlan(currentDate);
        const arr = state.plans[currentDate][slot.id];
        if(!arr.includes(obj.id)) arr.push(obj.id);
      }
    }
  }

  saveState();
  closeSuppModal();
  renderAll();
}

function deleteSuppModal(){
  if(!editingSuppId) return;
  const s = suppById(editingSuppId);
  if(!s) return;
  if(!confirm(`Delete "${s.name}"?`)) return;

  state.supplements = state.supplements.filter(x=>x.id!==editingSuppId);

  for(const d of Object.keys(state.plans)){
    for(const slotId of Object.keys(state.plans[d] || {})){
      state.plans[d][slotId] = (state.plans[d][slotId] || []).filter(x=>x!==editingSuppId);
    }
  }

  state.rules = state.rules.filter(r => r.aId!==editingSuppId && r.bId!==editingSuppId);

  saveState();
  closeSuppModal();
  renderAll();
}

// -------------------- Rules --------------------
function wireRules(){
  $("#addRuleBtn").addEventListener("click", ()=>{
    const aId = $("#ruleA").value;
    const bId = $("#ruleB").value;
    const type = $("#ruleType").value;
    const text = $("#ruleText").value.trim();

    if(!aId || !bId) return alert("Pick both supplements.");
    if(aId === bId) return alert("Pick two different supplements.");
    if(!text) return alert("Add details (e.g., spacing time or note).");

    const [x,y] = aId < bId ? [aId,bId] : [bId,aId];

    state.rules.push({
      id: uid("rule"),
      aId: x,
      bId: y,
      type,
      text,
      createdAt: Date.now()
    });

    $("#ruleText").value = "";
    saveState();
    renderRulesList();
    renderCheckResults();
  });

  $("#clearRulesBtn").addEventListener("click", ()=>{
    if(!confirm("Delete ALL rules?")) return;
    state.rules = [];
    saveState();
    renderRulesList();
    renderCheckResults();
  });
}

function renderRulePickers(){
  const a = $("#ruleA");
  const b = $("#ruleB");
  if(!a || !b) return;

  const opts = state.supplements.slice()
    .sort((x,y)=>x.name.localeCompare(y.name))
    .map(s=>`<option value="${s.id}">${escapeHTML(s.name)}</option>`).join("");

  a.innerHTML = `<option value="">— choose —</option>` + opts;
  b.innerHTML = `<option value="">— choose —</option>` + opts;
}

function renderRulesList(){
  const box = $("#rulesList");
  if(!box) return;
  box.innerHTML = "";

  const list = state.rules.slice().sort((a,b)=>b.createdAt-a.createdAt);
  if(list.length===0){
    box.innerHTML = `<div class="muted">No rules saved yet.</div>`;
    return;
  }

  for(const r of list){
    const A = suppById(r.aId)?.name || "Unknown";
    const B = suppById(r.bId)?.name || "Unknown";
    const label = r.type === "avoid" ? "Do not combine" : (r.type === "space" ? "Space apart" : "Note");

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div>
        <strong>${escapeHTML(A)} ↔ ${escapeHTML(B)}</strong>
        <div class="meta">${escapeHTML(label)} • ${escapeHTML(r.text)}</div>
      </div>
      <div class="right">
        <button class="btnSmall dangerBtn">Delete</button>
      </div>
    `;

    el.querySelector("button").addEventListener("click", ()=>{
      state.rules = state.rules.filter(x=>x.id!==r.id);
      saveState();
      renderRulesList();
      renderCheckResults();
    });

    box.appendChild(el);
  }
}

// -------------------- Checker --------------------
let checkSelected = new Set();

function wireChecker(){
  $("#clearCheckBtn").addEventListener("click", ()=>{
    checkSelected = new Set();
    renderCheckPicker();
    renderCheckResults();
  });
}

function renderCheckPicker(){
  const box = $("#checkPicker");
  if(!box) return;
  box.innerHTML = "";

  const list = state.supplements.slice().sort((a,b)=>a.name.localeCompare(b.name));
  if(list.length===0){
    box.innerHTML = `<div class="muted">Add supplements first, then you can check rules.</div>`;
    return;
  }

  for(const s of list){
    const pill = document.createElement("div");
    pill.className = "pill" + (checkSelected.has(s.id) ? " on" : "");
    pill.textContent = s.name;

    pill.addEventListener("click", ()=>{
      if(checkSelected.has(s.id)) checkSelected.delete(s.id);
      else checkSelected.add(s.id);
      renderCheckPicker();
      renderCheckResults();
    });

    box.appendChild(pill);
  }
}

function renderCheckResults(){
  const box = $("#checkResults");
  if(!box) return;

  const ids = Array.from(checkSelected);
  if(ids.length < 2){
    box.classList.add("muted");
    box.innerHTML = `Select at least <strong>two</strong> supplements to see rule-based notes.`;
    return;
  }

  const found = [];
  for(let i=0;i<ids.length;i++){
    for(let j=i+1;j<ids.length;j++){
      const aId = ids[i], bId = ids[j];
      const [x,y] = aId < bId ? [aId,bId] : [bId,aId];
      const rules = state.rules.filter(r => r.aId===x && r.bId===y);
      for(const r of rules) found.push(r);
    }
  }

  if(found.length===0){
    box.classList.add("muted");
    box.innerHTML = `
      <div><strong>No saved rules matched</strong> for this selection.</div>
      <div class="small muted">If you have pharmacist/doctor guidance, add it under the Rules tab.</div>
    `;
    return;
  }

  box.classList.remove("muted");
  const lines = found
    .map(r=>{
      const A = suppById(r.aId)?.name || "Unknown";
      const B = suppById(r.bId)?.name || "Unknown";
      const badge = r.type==="avoid" ? "⛔ Do not combine" : (r.type==="space" ? "⏱ Space apart" : "📝 Note");
      return `<li><strong>${escapeHTML(A)} ↔ ${escapeHTML(B)}</strong>: ${escapeHTML(badge)} — ${escapeHTML(r.text)}</li>`;
    }).join("");

  box.innerHTML = `<ul style="margin:0; padding-left:18px">${lines}</ul>`;
}

// -------------------- Time (device timezone) --------------------
function formatLocalTime(){
  const tz = localTZ();
  const now = new Date();

  const timeStr = new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(now);

  const dateStr = new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(now);

  $("#tzLabel").textContent = tz;
  $("#timeNow").textContent = timeStr;
  $("#dateNow").textContent = dateStr;
}

// -------------------- Weather (Open-Meteo) --------------------
function getSavedCity(){
  return localStorage.getItem(CITY_KEY) || DEFAULT_CITY;
}
function setSavedCity(city){
  localStorage.setItem(CITY_KEY, city);
}

function weatherCodeToText(code){
  const map = {
    0:"Clear",
    1:"Mostly clear", 2:"Partly cloudy", 3:"Overcast",
    45:"Fog", 48:"Depositing rime fog",
    51:"Light drizzle",53:"Drizzle",55:"Heavy drizzle",
    61:"Light rain",63:"Rain",65:"Heavy rain",
    71:"Light snow",73:"Snow",75:"Heavy snow",
    80:"Light showers",81:"Showers",82:"Violent showers",
    95:"Thunderstorm"
  };
  return map[code] || `Weather code ${code}`;
}

function loadCachedWeather(){
  const raw = localStorage.getItem(WEATHER_KEY);
  if(!raw) return null;
  try { return JSON.parse(raw); } catch(e){ return null; }
}

function renderWeather(data){
  if(!data){
    $("#weatherCity").textContent = "—";
    $("#tempNow").textContent = "—°";
    $("#weatherDesc").textContent = "—";
    $("#weatherMeta").textContent = "—";
    return;
  }
  $("#weatherCity").textContent = data.cityLabel || "—";
  $("#tempNow").textContent = (data.temperature ?? "—") + "°";
  $("#weatherDesc").textContent = weatherCodeToText(data.code);
  const mins = Math.round((Date.now() - (data.fetchedAt||Date.now()))/60000);
  $("#weatherMeta").textContent = `Updated ${mins} min ago • Wind: ${(data.wind ?? "—")} km/h`;
}

async function fetchWeatherByCity(city){
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const geoResp = await fetch(geoUrl);
  if(!geoResp.ok) throw new Error("Geocoding failed");
  const geo = await geoResp.json();
  const hit = geo?.results?.[0];
  if(!hit) throw new Error("City not found");

  const { latitude, longitude, name, admin1, country } = hit;
  const wxUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`;

  const wxResp = await fetch(wxUrl);
  if(!wxResp.ok) throw new Error("Weather fetch failed");
  const wx = await wxResp.json();

  const out = {
    cityLabel: [name, admin1, country].filter(Boolean).join(", "),
    temperature: wx?.current?.temperature_2m,
    wind: wx?.current?.wind_speed_10m,
    code: wx?.current?.weather_code,
    fetchedAt: Date.now()
  };

  localStorage.setItem(WEATHER_KEY, JSON.stringify(out));
  return out;
}

async function updateWeather(city){
  $("#weatherMeta").textContent = "Updating…";
  try{
    const data = await fetchWeatherByCity(city);
    renderWeather(data);
  }catch(e){
    const cached = loadCachedWeather();
    renderWeather(cached);
    $("#weatherMeta").textContent = cached
      ? `Offline / failed to update • showing last saved weather`
      : `Offline / failed to update • no saved weather yet`;
  }
}

async function cityFromGPS(){
  return new Promise((resolve, reject)=>{
    if(!navigator.geolocation) return reject(new Error("No GPS"));
    navigator.geolocation.getCurrentPosition(async (pos)=>{
      try{
        const { latitude, longitude } = pos.coords;
        const url = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${latitude}&longitude=${longitude}&language=en&format=json`;
        const resp = await fetch(url);
        if(!resp.ok) throw new Error("Reverse geocode failed");
        const data = await resp.json();
        const hit = data?.results?.[0];
        if(!hit?.name) throw new Error("No city name");
        resolve(hit.name);
      }catch(err){
        reject(err);
      }
    }, reject, { enableHighAccuracy:false, timeout:8000 });
  });
}

function wireWeatherUI(){
  const city = getSavedCity();
  $("#cityInput").value = city;

  renderWeather(loadCachedWeather());
  updateWeather(city);

  $("#useCityBtn").addEventListener("click", ()=>{
    const c = ($("#cityInput").value || "").trim();
    if(!c) return alert("Type a city name first.");
    setSavedCity(c);
    updateWeather(c);
  });

  $("#useGpsBtn").addEventListener("click", async ()=>{
    try{
      $("#weatherMeta").textContent = "Getting GPS city…";
      const gpsCity = await cityFromGPS();
      $("#cityInput").value = gpsCity;
      setSavedCity(gpsCity);
      await updateWeather(gpsCity);
    }catch(e){
      alert("Could not get city from GPS. You can type your city instead.");
      $("#weatherMeta").textContent = "GPS unavailable — type your city.";
    }
  });
}

// -------------------- Calendar / Appointments --------------------
let calView = { year: new Date().getFullYear(), month: new Date().getMonth() };
let calSelectedISO = todayISO();
let editingApptId = null;

function toISODateLocal(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function monthLabel(year, monthIdx){
  const d = new Date(year, monthIdx, 1);
  return new Intl.DateTimeFormat(undefined, { month:"long", year:"numeric" }).format(d);
}

function sameISO(a,b){ return String(a) === String(b); }

function apptsForDay(dateISO){
  return (state.appointments || [])
    .filter(a => a.dateISO === dateISO)
    .sort((x,y)=> (x.timeHHMM||"99:99").localeCompare(y.timeHHMM||"99:99"));
}

function apptHasDay(dateISO){
  return (state.appointments || []).some(a => a.dateISO === dateISO);
}

function renderCalendar(){
  const tzEl = $("#calTzLabel");
  if(tzEl) tzEl.textContent = localTZ();

  $("#calMonthLabel").textContent = monthLabel(calView.year, calView.month);

  const grid = $("#calGrid");
  grid.innerHTML = "";

  // DOW row
  const dows = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  for(const d of dows){
    const el = document.createElement("div");
    el.className = "calDow";
    el.textContent = d;
    grid.appendChild(el);
  }

  const first = new Date(calView.year, calView.month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(calView.year, calView.month+1, 0).getDate();

  const prevDays = new Date(calView.year, calView.month, 0).getDate();
  for(let i=0;i<startDow;i++){
    const dayNum = prevDays - startDow + 1 + i;
    const d = new Date(calView.year, calView.month-1, dayNum);
    addCalCell(grid, d, true);
  }

  for(let day=1; day<=daysInMonth; day++){
    const d = new Date(calView.year, calView.month, day);
    addCalCell(grid, d, false);
  }

  const totalCells = startDow + daysInMonth;
  const remainder = totalCells % 7;
  const fill = remainder === 0 ? 0 : (7 - remainder);
  for(let i=1;i<=fill;i++){
    const d = new Date(calView.year, calView.month+1, i);
    addCalCell(grid, d, true);
  }

  renderCalDayPanel();
}

function addCalCell(grid, dateObj, dim){
  const iso = toISODateLocal(dateObj);
  const isToday = sameISO(iso, todayISO());
  const isSel = sameISO(iso, calSelectedISO);

  const cell = document.createElement("div");
  cell.className = "calDay" + (dim ? " dim" : "") + (isToday ? " today" : "") + (isSel ? " sel" : "");
  cell.innerHTML = `<div class="n">${dateObj.getDate()}</div>`;

  if(apptHasDay(iso)){
    const dot = document.createElement("div");
    dot.className = "dot";
    cell.appendChild(dot);
  }

  cell.addEventListener("click", ()=>{
    calSelectedISO = iso;
    calView.year = dateObj.getFullYear();
    calView.month = dateObj.getMonth();
    renderCalendar();
  });

  grid.appendChild(cell);
}

function renderCalDayPanel(){
  $("#calDayLabel").textContent = new Intl.DateTimeFormat(undefined, {
    weekday:"long", year:"numeric", month:"long", day:"numeric"
  }).format(new Date(calSelectedISO+"T00:00:00"));

  const list = $("#calDayList");
  list.innerHTML = "";

  const items = apptsForDay(calSelectedISO);
  if(items.length === 0){
    list.innerHTML = `<div class="muted">No appointments for this day.</div>`;
    return;
  }

  for(const a of items){
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div>
        <strong>${escapeHTML(a.title)}</strong>
        <div class="meta">${escapeHTML((a.timeHHMM ? a.timeHHMM : "Time not set") + (a.location ? " • " + a.location : ""))}</div>
        ${a.notes ? `<div class="meta">${escapeHTML(a.notes)}</div>` : ""}
      </div>
      <div class="right">
        <button class="btnSmall">Edit</button>
      </div>
    `;
    el.querySelector("button").addEventListener("click", ()=> openApptModal(a.id));
    list.appendChild(el);
  }
}

function openApptModal(id){
  editingApptId = id || null;
  const modal = $("#apptModal");
  const isEdit = !!id;

  $("#apptTitle").textContent = isEdit ? "Edit Appointment" : "Add Appointment";
  $("#apptDelete").classList.toggle("hidden", !isEdit);

  const appt = isEdit ? (state.appointments || []).find(x=>x.id===id) : null;

  $("#apptName").value = appt?.title || "";
  $("#apptDate").value = appt?.dateISO || calSelectedISO;
  $("#apptTime").value = appt?.timeHHMM || "";
  $("#apptLoc").value = appt?.location || "";
  $("#apptNotes").value = appt?.notes || "";

  modal.classList.remove("hidden");
}

function closeApptModal(){
  $("#apptModal").classList.add("hidden");
  editingApptId = null;
}

function saveAppt(){
  const title = ($("#apptName").value || "").trim();
  const dateISO = $("#apptDate").value || calSelectedISO;
  const timeHHMM = ($("#apptTime").value || "").trim();
  const location = ($("#apptLoc").value || "").trim();
  const notes = ($("#apptNotes").value || "").trim();

  if(!title) return alert("Title is required.");

  const now = Date.now();
  const obj = {
    id: editingApptId || uid("appt"),
    title,
    dateISO,
    timeHHMM,
    location,
    notes,
    createdAt: editingApptId ? (state.appointments.find(a=>a.id===editingApptId)?.createdAt || now) : now,
    updatedAt: now
  };

  state.appointments = state.appointments || [];
  if(editingApptId){
    const idx = state.appointments.findIndex(a=>a.id===editingApptId);
    if(idx >= 0) state.appointments[idx] = obj;
  }else{
    state.appointments.push(obj);
  }

  saveState();
  calSelectedISO = dateISO;
  const d = new Date(dateISO+"T00:00:00");
  calView.year = d.getFullYear();
  calView.month = d.getMonth();

  closeApptModal();
  renderCalendar();
}

function deleteAppt(){
  if(!editingApptId) return;
  if(!confirm("Delete this appointment?")) return;

  state.appointments = (state.appointments || []).filter(a=>a.id!==editingApptId);
  saveState();
  closeApptModal();
  renderCalendar();
}

function wireCalendarUI(){
  $("#calPrevBtn").addEventListener("click", ()=>{
    const d = new Date(calView.year, calView.month-1, 1);
    calView.year = d.getFullYear();
    calView.month = d.getMonth();
    renderCalendar();
  });

  $("#calNextBtn").addEventListener("click", ()=>{
    const d = new Date(calView.year, calView.month+1, 1);
    calView.year = d.getFullYear();
    calView.month = d.getMonth();
    renderCalendar();
  });

  $("#calTodayBtn").addEventListener("click", ()=>{
    calSelectedISO = todayISO();
    const d = new Date(calSelectedISO+"T00:00:00");
    calView.year = d.getFullYear();
    calView.month = d.getMonth();
    renderCalendar();
  });

  $("#calAddBtn").addEventListener("click", ()=> openApptModal(null));

  $("#apptClose").addEventListener("click", closeApptModal);
  $("#apptCancel").addEventListener("click", closeApptModal);
  $("#apptSave").addEventListener("click", saveAppt);
  $("#apptDelete").addEventListener("click", deleteAppt);

  $("#apptModal").addEventListener("click", (e)=>{
    if(e.target.id === "apptModal") closeApptModal();
  });
}

// -------------------- Service Worker --------------------
async function registerSW(){
  if(!("serviceWorker" in navigator)) return;
  try{
    await navigator.serviceWorker.register("./sw.js?v=7");
  }catch(e){
    // silent
  }
}

// -------------------- Render all --------------------
function renderAll(){
  refreshNetBadge();
  ensurePlan(currentDate);
  renderSlots();
  renderSlotDetails();
  renderSuppList();
  renderRulesList();
  renderCheckPicker();
  renderCheckResults();
}

// -------------------- Init --------------------
function init(){
  refreshNetBadge();
  ensurePlan(currentDate);

  wireTabs();
  wireDateAndPrint();
  wireExportImport();
  wireSlots();
  wireSuppLibrary();
  wireSuppModal();
  wireRules();
  wireChecker();

  renderAll();

  // Time
  formatLocalTime();
  setInterval(formatLocalTime, 1000);

  // Weather
  wireWeatherUI();

  // Calendar
  wireCalendarUI();
  renderCalendar();

  registerSW();
}

init();