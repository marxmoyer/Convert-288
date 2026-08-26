import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.5/full/pyodide.mjs";

const statusEl = document.getElementById("status");
const fileInput = document.getElementById("fileInput");
const dropZone = document.getElementById("dropZone");
const dropFilename = document.getElementById("dropFilename");
const convertBtn = document.getElementById("convertBtn");
const downloadsEl = document.getElementById("downloads");
const resolvePanel = document.getElementById("resolvePanel");
const jobcodeRulesView = document.getElementById("jobcodeRulesView");
const transCodeRulesView = document.getElementById("transCodeRulesView");
const resetRulesBtn = document.getElementById("resetRulesBtn");
const employeeBanner = document.getElementById("employeeBanner");
const storageWarningEl = document.getElementById("storageWarning");

// The page's own privacy copy promises "saved only in this browser" — if a
// save ever silently no-ops (private-browsing storage restrictions, quota,
// a locked-down browser policy), the user needs to know now, not the next
// time they open this tab and find their profile/rules gone.
let storageWarningShown = false;
function notifyStorageFailure() {
  if (storageWarningShown || !storageWarningEl) return;
  storageWarningShown = true;
  storageWarningEl.innerHTML = "";
  storageWarningEl.style.display = "flex";
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = "⚠️";
  const text = document.createElement("span");
  text.innerHTML = "<strong>This browser won't save your info.</strong>";
  const detail = document.createElement("span");
  detail.textContent = " Profile and rules you enter this session won't be remembered after you close this tab — check for private/incognito mode or a full storage quota.";
  text.appendChild(detail);
  storageWarningEl.append(icon, text);
}

// Two kinds of status text: "flavor" (wildland-fire-themed, centered, shown
// while something's running in the background — the exact wording doesn't
// matter) and "result" (real information the user needs to read — left
// aligned, exact wording matters).
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.remove("result");
  statusEl.classList.toggle("error", isError);
}

function setResult(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.add("result");
  statusEl.classList.toggle("error", isError);
}

function fmtHours(n) {
  return String(Math.round(n * 100) / 100);
}

// Every rules-manager/resolve-panel button handler runs synchronous DOM
// reads and writes to localStorage-backed data — data a user (or a stray
// browser quota eviction) can shape unexpectedly. Wrapping a handler in
// guard() means a bug there shows the user something instead of the click
// just silently doing nothing, which is what a bare unguarded throw inside
// an event handler looks like.
// There's no cancel or progress bar for the Pyodide-driven work in boot()
// and convert() — without this, a pathological file (or a slow connection)
// leaves the UI sitting on a randomly-picked flavor string forever, with
// no way to tell "still working" apart from "frozen tab."
function startSlowWarning(message, delayMs = 20000) {
  const timer = setTimeout(() => setStatus(message), delayMs);
  return () => clearTimeout(timer);
}

function guard(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      console.error(err);
      setResult("Something went wrong: " + err.message, true);
    }
  };
}

// A finished conversion gets its own styled card (matching the rest of the
// page's fonts/spacing) instead of a plain preformatted text dump.
function setResultCard(result) {
  statusEl.classList.add("result");
  statusEl.classList.remove("error");
  statusEl.innerHTML = "";

  const card = document.createElement("div");
  card.className = "resultCard";

  const header = document.createElement("div");
  header.className = "resultCard-header";
  header.textContent = `${result.employee_name} — PP${result.pay_period_number} ${result.year}`;
  const dates = document.createElement("div");
  dates.className = "resultCard-dates";
  dates.textContent = `${result.period_start} to ${result.period_end}`;
  card.append(header, dates);

  const list = document.createElement("div");
  list.className = "resultCard-lines";
  if (result.lines.length === 0) {
    // Legitimate (e.g. a pay period entirely spent on home-unit duty with
    // no incident assignment) — but distinct enough from "you worked no
    // incident time" that it's worth saying explicitly, since a bare
    // empty card next to "Total: 0 hrs" reads like the parser failed.
    const empty = document.createElement("div");
    empty.className = "resultCard-empty";
    empty.textContent = "No incident time found on this pay period — every jobcode present was recognized and excluded (e.g. home-unit duty), or none matched.";
    list.appendChild(empty);
  }
  for (const line of result.lines) {
    const row = document.createElement("div");
    row.className = "resultCard-line";
    const name = document.createElement("span");
    name.className = "resultCard-line-name";
    name.textContent = line.name;
    const detail = document.createElement("span");
    detail.className = "resultCard-line-detail";
    detail.textContent = `Account: ${line.accounting_code} · ${fmtHours(line.hours)} hrs · ${line.days} day${line.days === 1 ? "" : "s"}`;
    row.append(name, detail);
    list.appendChild(row);
  }
  card.appendChild(list);

  const total = document.createElement("div");
  total.className = "resultCard-total";
  total.textContent = `Total: ${fmtHours(result.grand_total)} hrs`;
  card.appendChild(total);

  statusEl.appendChild(card);
}

function pick(phrases) {
  return phrases[Math.floor(Math.random() * phrases.length)];
}

const FLAVOR = {
  boot: ["Packing line gear…", "Loading Topper", "Fighting with supply..."],
  install: ["Sharpening the pulaskis…", "Fueling up the saws…", "Testing the radios…"],
  briefing: ["Getting the morning briefing…", "Checking the weather…", "Reviewing the IAP…"],
  reading: ["Sizing up the fire…", "Scouting the perimeter…", "Walking the line…"],
  detecting: ["Calling roll…", "Checking the crew roster…", "Radio check, radio check…"],
  digging: [
    "Digging line…", "Cutting fireline…", "Bringing fire…",
    "Checking for 16s and H…", "Gridding for hot spots…", "Running the pulaski…",
    "Doing the LCES check…", "Mopping up…", "Reading the 214…",
  ],
  ready: [
    "Anchor point secured — drop a paystub above.",
    "Staged and ready for dispatch — drop a paystub above.",
    "Holding at the trailhead — drop a paystub above when you're ready.",
    "Crew's briefed and standing by — drop a paystub above.",
  ],
};

// Assets shared with the desktop CLI live one directory up; pdfminer_words.py
// is browser-only (replaces pdfplumber, which can't install under Pyodide).
// profile.json / jobcode_rules.json / trans_code_rules.json are NOT fetched
// from the repo — they're personal to each employee, kept in this browser's
// localStorage only, and written into the Pyodide filesystem fresh before
// every conversion.
const SHARED_ASSETS = [
  "../paycheck8_parser.py",
  "../of288_filler.py",
  "../of288_excel_filler.py",
  "../ref/OF288 Excel Blank Template.xlsx",
];
const LOCAL_ASSETS = ["pdfminer_words.py"];

// --- Storage -----------------------------------------------------------
//
// One person often runs this for a whole crew, not just themselves. Two
// different scopes of data result:
//
// - Profile fields (Hired At, Hiring Unit, Type of Employment) are
//   genuinely personal — kept per employee, keyed by employee name as
//   detected from the paystub.
// - Jobcode rules and trans-code rules describe an INCIDENT or a pay code,
//   not a person — the same fire code means the same incident/accounting
//   info no matter which crew member worked it. These are shared across
//   every employee in this browser, entered once, so a second employee
//   working the same fire never has to re-enter it.

const EMPLOYEES_KEY = "of288_employees_v1";
const SHARED_JOBCODE_RULES_KEY = "of288_shared_jobcode_rules_v1";
const SHARED_TRANS_CODE_RULES_KEY = "of288_shared_trans_code_rules_v1";

const DEFAULT_TRANS_RULES = {
  "01": { include: true, note: "Regular hours" },
  "21": { include: true, note: "Overtime hours" },
  "14": { include: false, flag: "H", note: "Hazard pay differential — flags the matching worked-hours row with H instead of adding separate hours" },
  "66": { include: false, note: "Other Leave (per TNAINST: jury duty, funeral, admin leave, hazardous weather dismissal, etc. — any paid absence not charged to annual/sick/comp leave) — not worked time, excluded entirely (no flag)" },
  "31": { include: true, note: "Holiday worked at the basic rate of pay" },
};

function normalizeEmployeeKey(name) {
  return name.trim().toUpperCase().replace(/\s+/g, " ");
}

function loadAllEmployees() {
  try {
    return JSON.parse(localStorage.getItem(EMPLOYEES_KEY) || "{}");
  } catch {
    notifyStorageFailure();
    return {};
  }
}

function saveAllEmployees(employees) {
  try {
    localStorage.setItem(EMPLOYEES_KEY, JSON.stringify(employees));
  } catch {
    notifyStorageFailure();
  }
}

function getEmployee(key) {
  return loadAllEmployees()[key] || null;
}

function ensureEmployee(key, displayName) {
  const employees = loadAllEmployees();
  if (!employees[key]) {
    employees[key] = { displayName, profile: {} };
    saveAllEmployees(employees);
  }
  return employees[key];
}

function updateEmployee(key, patch) {
  const employees = loadAllEmployees();
  employees[key] = { ...employees[key], ...patch };
  saveAllEmployees(employees);
}

// One-time upgrade from the old per-employee rule storage: merge whatever
// every employee had saved into the new shared store, then drop the
// now-redundant per-employee copies. Runs once — after the shared key
// exists (even as {}), this is a no-op forever.
function migrateEmployeeScopedRulesToShared() {
  if (localStorage.getItem(SHARED_JOBCODE_RULES_KEY) !== null) return;
  const employees = loadAllEmployees();
  const jobcodeRules = {};
  const transCodeRules = { ...DEFAULT_TRANS_RULES };
  for (const emp of Object.values(employees)) {
    Object.assign(jobcodeRules, emp.jobcode_rules || {});
    Object.assign(transCodeRules, emp.trans_code_rules || {});
    delete emp.jobcode_rules;
    delete emp.trans_code_rules;
  }
  try {
    localStorage.setItem(SHARED_JOBCODE_RULES_KEY, JSON.stringify(jobcodeRules));
    localStorage.setItem(SHARED_TRANS_CODE_RULES_KEY, JSON.stringify(transCodeRules));
  } catch {
    notifyStorageFailure();
  }
  saveAllEmployees(employees);
}

// --- Profile form ----------------------------------------------------------

const PROFILE_FIELDS = {
  p_hired_at: "1_hired_at",
  p_eci: "2_employee_common_identifier", // hidden input; IBG says leave blank for regular employees anyway
  p_type: "3_type_of_employment",
  p_unit_name: "4_hiring_unit_name",
  p_phone: "6_hiring_unit_phone",
  // Hiring Unit Fax dropped from the UI entirely — never used, always blank on output
};

function loadProfileIntoForm(employeeKey) {
  const emp = getEmployee(employeeKey);
  const saved = emp ? emp.profile : {};
  for (const [inputId, profileKey] of Object.entries(PROFILE_FIELDS)) {
    // Only overwrite when there's an actual saved value — forcing "" onto
    // the Type of Employment <select> (which has no blank option) leaves it
    // with no real selection at all despite still visually showing
    // "Federal", so a brand-new employee's profile would silently save an
    // empty string there and crash the conversion downstream.
    if (saved[profileKey]) {
      document.getElementById(inputId).value = saved[profileKey];
    }
  }
}

function readProfileFromForm(employeeKey) {
  const profile = {};
  for (const [inputId, profileKey] of Object.entries(PROFILE_FIELDS)) {
    profile[profileKey] = document.getElementById(inputId).value.trim();
  }
  updateEmployee(employeeKey, { profile });
  return profile;
}

function profileLooksComplete(profile) {
  return Boolean(profile["1_hired_at"] && profile["4_hiring_unit_name"]);
}

// --- Jobcode / trans-code rules (shared across every employee) ---------

function loadJobcodeRules() {
  try {
    return JSON.parse(localStorage.getItem(SHARED_JOBCODE_RULES_KEY) || "{}");
  } catch {
    notifyStorageFailure();
    return {};
  }
}

function saveJobcodeRules(rules) {
  try {
    localStorage.setItem(SHARED_JOBCODE_RULES_KEY, JSON.stringify(rules));
  } catch {
    notifyStorageFailure();
  }
  renderRulesView();
}

function loadTransCodeRules() {
  try {
    const raw = localStorage.getItem(SHARED_TRANS_CODE_RULES_KEY);
    return raw ? JSON.parse(raw) : { ...DEFAULT_TRANS_RULES };
  } catch {
    notifyStorageFailure();
    return { ...DEFAULT_TRANS_RULES };
  }
}

function saveTransCodeRules(rules) {
  try {
    localStorage.setItem(SHARED_TRANS_CODE_RULES_KEY, JSON.stringify(rules));
  } catch {
    notifyStorageFailure();
  }
  renderRulesView();
}

// Rules live in localStorage, which anyone can hand-edit via devtools, and
// can also end up half-written by a quota eviction mid-save — so treat
// every stored rule as untrusted shape, not just untrusted content. A
// malformed entry here must never throw: this runs during boot() (before
// error handling exists yet) and inside nearly every rules-manager button
// handler, so one bad entry throwing would take the whole page down with it.
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jobcodeRuleSummary(rule) {
  if (!isPlainObject(rule)) return "(invalid saved entry — delete and re-add it)";
  if (rule.include === false) {
    return `Excluded${rule.note ? " — " + rule.note : ""}`;
  }
  const bits = [`Incident: ${rule.incident_name || rule.group || "(no incident name)"}`];
  bits.push(`Account: ${rule.accounting_code || "—"}`);
  if (rule.fire_code) bits.push(`Fire Code: ${rule.fire_code}`);
  return bits.join(" · ");
}

function transCodeRuleSummary(rule) {
  if (!isPlainObject(rule)) return "(invalid saved entry — delete and re-add it)";
  if (rule.include) return `Included as worked hours${rule.note ? " — " + rule.note : ""}`;
  if (rule.flag) return `Excluded, flags matching hours ${rule.flag}${rule.note ? " — " + rule.note : ""}`;
  return `Excluded entirely${rule.note ? " — " + rule.note : ""}`;
}

function renderRuleRow(container, code, summary, onEdit, onDelete) {
  const row = document.createElement("div");
  row.className = "ruleRow";
  const main = document.createElement("div");
  main.className = "ruleRow-main";
  const codeSpan = document.createElement("span");
  codeSpan.className = "ruleRow-code";
  codeSpan.textContent = code; // jobcode/trans code text ultimately comes from the uploaded PDF — never interpolate into innerHTML
  const summarySpan = document.createElement("span");
  summarySpan.className = "ruleRow-summary";
  summarySpan.textContent = summary;
  main.append(codeSpan, summarySpan);
  const actions = document.createElement("div");
  actions.className = "ruleRow-actions";
  const editBtn = document.createElement("button");
  editBtn.className = "linklike";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", guard(onEdit));
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "linklike danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", guard(onDelete));
  actions.append(editBtn, deleteBtn);
  row.append(main, actions);
  container.appendChild(row);
}

function renderRulesView() {
  const jobcodeRules = loadJobcodeRules();
  jobcodeRulesView.innerHTML = "";
  const jobcodes = Object.keys(jobcodeRules).sort();
  if (!jobcodes.length) {
    jobcodeRulesView.innerHTML = '<p class="hint">(none yet)</p>';
  } else {
    for (const code of jobcodes) {
      renderRuleRow(
        jobcodeRulesView,
        code,
        jobcodeRuleSummary(jobcodeRules[code]),
        () => openJobcodeEditForm(code, jobcodeRules[code]),
        () => {
          if (!confirm(`Delete the saved rule for jobcode ${code}? This can't be undone.`)) return;
          const rules = loadJobcodeRules();
          delete rules[code];
          saveJobcodeRules(rules);
        }
      );
    }
  }

  const transCodeRules = loadTransCodeRules();
  transCodeRulesView.innerHTML = "";
  for (const code of Object.keys(transCodeRules).sort()) {
    renderRuleRow(
      transCodeRulesView,
      code,
      transCodeRuleSummary(transCodeRules[code]),
      () => openTransCodeEditForm(code, transCodeRules[code]),
      () => {
        if (!confirm(`Delete the saved rule for trans code ${code}? This can't be undone.`)) return;
        const rules = loadTransCodeRules();
        delete rules[code];
        saveTransCodeRules(rules);
      }
    );
  }
}

function openJobcodeEditForm(code, rule) {
  if (!isPlainObject(rule)) rule = { include: false };
  resolvePanel.style.display = "block";
  resolvePanel.innerHTML = `
    <h3 id="ef_header"></h3>
    <div class="row">
      <label>Treatment
        <select id="ef_treatment">
          <option value="include">Incident time</option>
          <option value="exclude">Not incident time (excluded)</option>
        </select>
      </label>
    </div>
    <div class="row" id="ef_incident_fields">
      ${INCIDENT_FIELDS.map(([, key, label, placeholder]) => `
        <label>${label}<input id="ef_${key}" placeholder="${placeholder}"></label>`).join("")}
    </div>
    <div class="actions">
      <button id="ef_save">Save</button>
      <button id="ef_cancel" class="secondary">Cancel</button>
    </div>
  `;
  // jobcode text ultimately comes from the uploaded PDF — set via
  // textContent, not interpolated into the innerHTML template above.
  document.getElementById("ef_header").textContent = `Edit jobcode ${code}`;
  const treatmentSelect = document.getElementById("ef_treatment");
  const fieldsRow = document.getElementById("ef_incident_fields");
  treatmentSelect.value = rule.include === false ? "exclude" : "include";
  fieldsRow.style.display = treatmentSelect.value === "exclude" ? "none" : "flex";
  treatmentSelect.addEventListener("change", () => {
    fieldsRow.style.display = treatmentSelect.value === "exclude" ? "none" : "flex";
  });
  for (const [, key] of INCIDENT_FIELDS) {
    document.getElementById(`ef_${key}`).value = rule[key] || "";
  }

  document.getElementById("ef_save").addEventListener("click", guard(() => {
    const rules = loadJobcodeRules();
    if (treatmentSelect.value === "exclude") {
      rules[code] = { include: false, note: rule.note || "Excluded via rules manager." };
    } else {
      const values = {};
      for (const [, key] of INCIDENT_FIELDS) {
        values[key] = document.getElementById(`ef_${key}`).value.trim();
      }
      const preserved = rule.trans_overrides ? { trans_overrides: rule.trans_overrides } : {};
      rules[code] = { include: true, group: values.incident_name, ...values, ...preserved };
    }
    saveJobcodeRules(rules);
    resolvePanel.style.display = "none";
  }));
  document.getElementById("ef_cancel").addEventListener("click", guard(() => {
    resolvePanel.style.display = "none";
  }));
}

function openTransCodeEditForm(code, rule) {
  if (!isPlainObject(rule)) rule = { include: false };
  resolvePanel.style.display = "block";
  resolvePanel.innerHTML = `
    <h3 id="ef_header"></h3>
    <div class="row">
      <label>Treatment
        <select id="ef_treatment">
          <option value="include">Include as worked hours</option>
          <option value="flag_H">Exclude, but flag the matching hours as H (hazard pay)</option>
          <option value="flag_T">Exclude, but flag the matching hours as T (travel)</option>
          <option value="flag_E">Exclude, but flag the matching hours as E (environmental differential)</option>
          <option value="exclude">Exclude entirely — not incident time</option>
        </select>
      </label>
    </div>
    <div class="actions">
      <button id="ef_save">Save</button>
      <button id="ef_cancel" class="secondary">Cancel</button>
    </div>
  `;
  // trans code text ultimately comes from the uploaded PDF — set via
  // textContent, not interpolated into the innerHTML template above.
  document.getElementById("ef_header").textContent = `Edit trans code ${code}`;
  const treatmentSelect = document.getElementById("ef_treatment");
  treatmentSelect.value = rule.include ? "include" : rule.flag ? `flag_${rule.flag}` : "exclude";

  document.getElementById("ef_save").addEventListener("click", guard(() => {
    const treatment = treatmentSelect.value;
    const rules = loadTransCodeRules();
    if (treatment === "include") {
      rules[code] = { include: true, note: rule.note || "Edited via rules manager" };
    } else if (treatment === "exclude") {
      rules[code] = { include: false, note: rule.note || "Edited via rules manager" };
    } else {
      const flag = treatment.split("_")[1];
      rules[code] = { include: false, flag, note: rule.note || "Edited via rules manager" };
    }
    saveTransCodeRules(rules);
    resolvePanel.style.display = "none";
  }));
  document.getElementById("ef_cancel").addEventListener("click", guard(() => {
    resolvePanel.style.display = "none";
  }));
}

resetRulesBtn.addEventListener("click", guard(() => {
  if (!confirm("Reset ALL saved incident/trans-code rules? This affects every employee in this browser and can't be undone.")) return;
  saveJobcodeRules({});
  saveTransCodeRules({ ...DEFAULT_TRANS_RULES });
}));

// --- Drag & drop ----------------------------------------------------------

function setSelectedFile(file) {
  if (!file) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  dropFilename.textContent = file.name;
}

fileInput.addEventListener("change", () => setSelectedFile(fileInput.files[0]));

["dragenter", "dragover"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
  })
);
dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file && file.type === "application/pdf") {
    setSelectedFile(file);
  } else {
    setResult("Please drop a PDF file.", true);
  }
});

// --- Pyodide boot ----------------------------------------------------------

let pyodide;
let currentEmployeeKey = null;

async function boot() {
  const clearSlowWarning = startSlowWarning(
    "Still starting up — this can take longer on a slow connection or an older device."
  );
  try {
    // These read/render whatever's already in localStorage, which could be
    // malformed (hand-edited via devtools, half-written by a quota
    // eviction) — inside the try so a bad entry shows "Failed to start"
    // instead of leaving the page stuck on its static initial text forever.
    migrateEmployeeScopedRulesToShared();
    renderRulesView();

    setStatus(pick(FLAVOR.boot));
    pyodide = await loadPyodide();

    setStatus(pick(FLAVOR.install));
    await pyodide.loadPackage("micropip");
    const micropip = pyodide.pyimport("micropip");
    await micropip.install(["pdfminer.six", "openpyxl"]);

    setStatus(pick(FLAVOR.briefing));
    for (const path of [...SHARED_ASSETS, ...LOCAL_ASSETS]) {
      const resp = await fetch(encodeURI(path));
      if (!resp.ok) {
        throw new Error(`Failed to fetch ${path}: ${resp.status} ${resp.statusText}`);
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const name = path.split("/").pop();
      pyodide.FS.writeFile("/" + name, bytes);
    }

    pyodide.runPython(`
import sys
if "/" not in sys.path:
    sys.path.insert(0, "/")
`);

    setStatus(pick(FLAVOR.ready));
    fileInput.disabled = false;
    convertBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setResult("Failed to start: " + err.message, true);
  } finally {
    clearSlowWarning();
  }
}

// --- Conversion --------------------------------------------------------

async function detectEmployeeName() {
  const nameJson = await pyodide.runPythonAsync(`
import json, traceback
import paycheck8_parser
def _run():
    import pdfminer_words
    words = pdfminer_words.extract_words("/paystub.pdf")
    stub, _ = paycheck8_parser.parse_from_words(words)
    return {"ok": True, "name": stub.employee_name}
try:
    result = _run()
except paycheck8_parser.TotalHoursMismatchError as e:
    # This IS a real Paycheck8 paystub — the header parsed fine — but the
    # daily-hours grid didn't fully reconcile against its own printed
    # total, which means a row was probably missed. Surface this
    # specifically rather than the generic "not a paystub" message below.
    result = {"ok": False, "kind": "hours_mismatch", "message": str(e)}
except Exception:
    # Anything else means this file doesn't look like a Paycheck8 Time &
    # Attendance PDF at all — not necessarily a bug. Keep the traceback
    # for our own debugging, but don't show it to the user.
    result = {"ok": False, "debug": traceback.format_exc()}
json.dumps(result)
`);
  return JSON.parse(nameJson);
}

async function convert() {
  const file = fileInput.files[0];
  if (!file) {
    setResult("Choose a paystub PDF first.", true);
    return;
  }

  resolvePanel.style.display = "none";
  downloadsEl.innerHTML = "";
  convertBtn.disabled = true;
  const clearSlowWarning = startSlowWarning(
    "Still working — this file may be unusually large or complex."
  );
  try {
    setStatus(pick(FLAVOR.reading));
    const bytes = new Uint8Array(await file.arrayBuffer());
    pyodide.FS.writeFile("/paystub.pdf", bytes);

    setStatus(pick(FLAVOR.detecting));
    const detected = await detectEmployeeName();
    if (!detected.ok) {
      if (detected.kind === "hours_mismatch") {
        setResult(detected.message, true);
      } else {
        console.error(detected.debug);
        setResult("This doesn't look like a Paycheck8 paystub. Please upload a Paycheck8 Time & Attendance PDF.", true);
      }
      return;
    }

    const detectedKey = normalizeEmployeeKey(detected.name);
    const switchingEmployee = detectedKey !== currentEmployeeKey;
    currentEmployeeKey = detectedKey;
    const isNewEmployee = getEmployee(currentEmployeeKey) === null;
    ensureEmployee(currentEmployeeKey, detected.name);
    // Only reload the form from storage when switching to a different
    // employee than last time — otherwise this clobbers profile fields the
    // user just typed in (e.g. filling in a brand-new employee's info and
    // clicking Convert again to proceed) with the still-blank saved copy.
    if (switchingEmployee) {
      loadProfileIntoForm(currentEmployeeKey);
    }
    employeeBanner.textContent = `Employee: ${detected.name}`;
    employeeBanner.style.display = "block";

    const profile = readProfileFromForm(currentEmployeeKey);
    if (isNewEmployee || !profileLooksComplete(profile)) {
      setResult(
        `New/incomplete profile for ${detected.name}. Fill in their info above ` +
        `(at least Hired At and Hiring Unit Name), then click Convert again.`
      );
      return;
    }

    pyodide.FS.writeFile("/profile.json", new TextEncoder().encode(JSON.stringify(profile)));
    pyodide.FS.writeFile("/jobcode_rules.json", new TextEncoder().encode(JSON.stringify(loadJobcodeRules())));
    pyodide.FS.writeFile("/trans_code_rules.json", new TextEncoder().encode(JSON.stringify(loadTransCodeRules())));

    setStatus(pick(FLAVOR.digging));
    const resultJson = await pyodide.runPythonAsync(`
import json, traceback
import paycheck8_parser

def _run():
    import pdfminer_words, of288_filler, of288_excel_filler

    words = pdfminer_words.extract_words("/paystub.pdf")
    stub, _ = paycheck8_parser.parse_from_words(words)

    jobcode_rules = json.load(open("/jobcode_rules.json"))
    trans_code_rules = json.load(open("/trans_code_rules.json"))
    profile = json.load(open("/profile.json"))

    try:
        groups, reserved = of288_filler.build_groups(stub, jobcode_rules, trans_code_rules)
    except of288_filler.UnrecognizedCodeError as e:
        return {
            "ok": False,
            "unrecognized": {
                "kind": e.kind,
                "jobcode": e.jobcode,
                "override": e.override,
                "trans_code": e.trans_code,
                "hours_by_date": {d.isoformat(): h for d, h in e.hours_by_date.items()},
            },
        }

    try:
        out_paths, grand_total = of288_excel_filler.fill(
            stub, groups, reserved, "/OF288 Excel Blank Template.xlsx", profile, "/output.xlsx"
        )
    except of288_filler.ScheduleAllocationError as e:
        return {"ok": False, "error": str(e)}

    lines = []
    for name, g in groups.items():
        if not g["dates"]:
            continue  # every date this group had got excluded down to nothing
        total = sum(e["hours"] for e in g["dates"].values())
        lines.append({
            "name": name,
            "accounting_code": g["meta"]["accounting_code"],
            "hours": total,
            "days": len(g["dates"]),
        })

    return {
        "ok": True,
        "employee_name": stub.employee_name.title(),
        "period_start": stub.period_start.isoformat(),
        "period_end": stub.period_end.isoformat(),
        "lines": lines,
        "grand_total": grand_total,
        "out_paths": out_paths,
        "pay_period_number": stub.pay_period_number,
        "year": stub.year,
    }

try:
    result = _run()
except paycheck8_parser.TotalHoursMismatchError as e:
    result = {"ok": False, "error": str(e)}
except Exception:
    # Something not specifically anticipated (a malformed rule, an
    # unusual PDF layout, a corrupted template asset, ...) — give a short
    # message instead of dumping a raw traceback into the result box, but
    # keep the traceback available in the console for real debugging.
    result = {
        "ok": False,
        "error": "Something unexpected went wrong converting this paystub. "
                 "Check the browser console for technical details, or try a different file.",
        "debug": traceback.format_exc(),
    }

json.dumps(result)
`);

    const result = JSON.parse(resultJson);

    if (!result.ok && result.unrecognized) {
      setResult("Needs your input before this can finish converting — see below.");
      showResolvePanel(result.unrecognized);
      return;
    }
    if (!result.ok) {
      if (result.debug) console.error(result.debug);
      setResult("Cannot convert:\n" + result.error, true);
      return;
    }

    setResultCard(result);
    const base = `OF288_PP${result.pay_period_number}_${result.year}`;
    result.out_paths.forEach((path, i) => {
      const data = pyodide.FS.readFile(path);
      const blob = new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = i === 0 ? `${base}.xlsx` : `${base}_page${i + 1}.xlsx`;
      a.textContent = "Download " + a.download;
      downloadsEl.appendChild(a);
    });
  } catch (err) {
    console.error(err);
    setResult("Error: " + err.message, true);
  } finally {
    convertBtn.disabled = false;
    clearSlowWarning();
  }
}

// --- Resolution panel for unrecognized jobcodes/trans codes -------------

function formatHoursByDate(hoursByDate) {
  return Object.entries(hoursByDate)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([d, h]) => `  ${d}: ${h}h`)
    .join("\n");
}

function showResolvePanel(info) {
  resolvePanel.innerHTML = "";
  resolvePanel.style.display = "block";

  if (info.kind === "jobcode") {
    renderJobcodeResolveForm(info);
  } else {
    renderTransCodeResolveForm(info);
  }
}

const INCIDENT_FIELDS = [
  ["rf_incident_name", "incident_name", "Incident name", "e.g. Aspen Acres"],
  ["rf_order_number", "incident_order_number", "Incident order number", "e.g. CO-CUX-1160"],
  ["rf_fire_code", "fire_code", "Fire code", "e.g. SSB5"],
  ["rf_resource_request", "resource_request_number", "Resource request number", "e.g. O-33"],
  ["rf_position_code", "position_code", "Position code", "e.g. FFT1"],
  ["rf_acct", "accounting_code", "Accounting code", "e.g. 1542"],
];

function renderJobcodeResolveForm(info) {
  const jobcodeRules = loadJobcodeRules();
  const existingByName = {};
  for (const rule of Object.values(jobcodeRules)) {
    if (rule.incident_name) existingByName[rule.incident_name] = rule;
  }
  const existingNames = Object.keys(existingByName);

  resolvePanel.innerHTML = `
    <h3 id="rf_header"></h3>
    <div class="details" id="rf_details"></div>
    <p class="hint">What incident is this for ${currentEmployeeKey}? (Type an incident name you've
    already used and the rest fills in automatically.) None of this is guessable from the paystub —
    it comes from the resource order.</p>
    <div class="row">
      ${INCIDENT_FIELDS.map(([id, , label, placeholder]) => `
        <label>${label}
          ${id === "rf_incident_name"
            ? `<input id="${id}" list="rf_incident_list" placeholder="${placeholder}">
               <datalist id="rf_incident_list">${existingNames.map((n) => `<option value="${n}">`).join("")}</datalist>`
            : `<input id="${id}" placeholder="${placeholder}">`}
        </label>`).join("")}
    </div>
    <div class="actions">
      <button id="rf_save">Save & continue</button>
      <button id="rf_exclude" class="secondary">This isn't incident time — exclude it</button>
    </div>
  `;
  // jobcode/override/trans_code come from the uploaded PDF — set via
  // textContent, not interpolated into the innerHTML template above.
  document.getElementById("rf_header").textContent = `New jobcode found: ${info.jobcode}`;
  document.getElementById("rf_details").textContent =
    `Override/accounting code on paystub: ${info.override}\n` +
    `Trans code: ${info.trans_code}\n` +
    `Hours found on:\n${formatHoursByDate(info.hours_by_date)}`;

  const nameInput = document.getElementById("rf_incident_name");
  nameInput.addEventListener("input", () => {
    const match = existingByName[nameInput.value];
    if (!match) return;
    for (const [id, key] of INCIDENT_FIELDS) {
      if (key !== "incident_name") document.getElementById(id).value = match[key] || "";
    }
  });

  document.getElementById("rf_save").addEventListener("click", guard(() => {
    const values = {};
    for (const [id, key] of INCIDENT_FIELDS) {
      values[key] = document.getElementById(id).value.trim();
    }
    if (!values.incident_name || !values.accounting_code) {
      alert("Please fill in at least the incident name and accounting code.");
      return;
    }
    jobcodeRules[info.jobcode] = { include: true, group: values.incident_name, ...values };
    saveJobcodeRules(jobcodeRules);
    resolvePanel.style.display = "none";
    convert();
  }));

  document.getElementById("rf_exclude").addEventListener("click", guard(() => {
    jobcodeRules[info.jobcode] = { include: false, note: "Excluded via web UI — not incident time." };
    saveJobcodeRules(jobcodeRules);
    resolvePanel.style.display = "none";
    convert();
  }));
}

function renderTransCodeResolveForm(info) {
  resolvePanel.innerHTML = `
    <h3 id="rf_header"></h3>
    <div class="details" id="rf_details"></div>
    <p class="hint">How should this trans code's hours be treated?</p>
    <div class="row">
      <label>Treatment
        <select id="rf_treatment">
          <option value="include">Include as worked hours</option>
          <option value="flag_H">Exclude, but flag the matching hours as H (hazard pay)</option>
          <option value="flag_T">Exclude, but flag the matching hours as T (travel)</option>
          <option value="flag_E">Exclude, but flag the matching hours as E (environmental differential)</option>
          <option value="exclude">Exclude entirely — not incident time</option>
        </select>
      </label>
    </div>
    <div class="actions">
      <button id="rf_save">Save & continue</button>
    </div>
  `;
  // jobcode/override/trans_code come from the uploaded PDF — set via
  // textContent, not interpolated into the innerHTML template above.
  document.getElementById("rf_header").textContent = `New trans code found: ${info.trans_code}`;
  document.getElementById("rf_details").textContent =
    `Seen on jobcode: ${info.jobcode} (override ${info.override})\n` +
    `Hours found on:\n${formatHoursByDate(info.hours_by_date)}`;

  document.getElementById("rf_save").addEventListener("click", guard(() => {
    const treatment = document.getElementById("rf_treatment").value;
    const transRules = loadTransCodeRules();
    if (treatment === "include") {
      transRules[info.trans_code] = { include: true, note: "Added via web UI" };
    } else if (treatment === "exclude") {
      transRules[info.trans_code] = { include: false, note: "Added via web UI" };
    } else {
      const flag = treatment.split("_")[1];
      transRules[info.trans_code] = { include: false, flag, note: "Added via web UI" };
    }
    saveTransCodeRules(transRules);
    resolvePanel.style.display = "none";
    convert();
  }));
}

convertBtn.addEventListener("click", convert);
// boot() has its own try/catch covering everything it does, but this is a
// last-resort net: without it, any error boot() somehow doesn't catch
// becomes a silent unhandled promise rejection — the page just sits on
// its static initial text forever, with only a console error no user
// would ever see.
boot().catch((err) => {
  console.error(err);
  setResult("Failed to start: " + err.message, true);
});
