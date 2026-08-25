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
  "../field_map.json",
  "../OF288-Fillable.pdf",
];
const LOCAL_ASSETS = ["pdfminer_words.py"];

// --- Per-employee storage -------------------------------------------------
//
// One person often runs this for a whole crew, not just themselves, so
// storage is keyed by employee (detected from the paystub's own "Employee
// Name" field) rather than assuming one browser == one employee. Each
// employee gets their own profile fields, jobcode rules, and trans-code
// rules, all under one localStorage entry.

const EMPLOYEES_KEY = "of288_employees_v1";

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
    return {};
  }
}

function saveAllEmployees(employees) {
  try {
    localStorage.setItem(EMPLOYEES_KEY, JSON.stringify(employees));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — non-fatal
  }
}

function getEmployee(key) {
  return loadAllEmployees()[key] || null;
}

function ensureEmployee(key, displayName) {
  const employees = loadAllEmployees();
  if (!employees[key]) {
    employees[key] = {
      displayName,
      profile: {},
      jobcode_rules: {},
      trans_code_rules: { ...DEFAULT_TRANS_RULES },
    };
    saveAllEmployees(employees);
  }
  return employees[key];
}

function updateEmployee(key, patch) {
  const employees = loadAllEmployees();
  employees[key] = { ...employees[key], ...patch };
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

// --- Jobcode / trans-code rules ---------------------------------------

function loadJobcodeRules(employeeKey) {
  const emp = getEmployee(employeeKey);
  return emp ? { ...emp.jobcode_rules } : {};
}

function saveJobcodeRules(employeeKey, rules) {
  updateEmployee(employeeKey, { jobcode_rules: rules });
  renderRulesView(employeeKey);
}

function loadTransCodeRules(employeeKey) {
  const emp = getEmployee(employeeKey);
  return emp && emp.trans_code_rules ? { ...emp.trans_code_rules } : { ...DEFAULT_TRANS_RULES };
}

function saveTransCodeRules(employeeKey, rules) {
  updateEmployee(employeeKey, { trans_code_rules: rules });
  renderRulesView(employeeKey);
}

function renderRulesView(employeeKey) {
  if (!employeeKey) {
    jobcodeRulesView.textContent = "(upload a paystub to see an employee's saved rules)";
    transCodeRulesView.textContent = "";
    return;
  }
  const jobcodeRules = loadJobcodeRules(employeeKey);
  jobcodeRulesView.textContent = Object.keys(jobcodeRules).length
    ? JSON.stringify(jobcodeRules, null, 2)
    : "(none yet)";
  transCodeRulesView.textContent = JSON.stringify(loadTransCodeRules(employeeKey), null, 2);
}

resetRulesBtn.addEventListener("click", () => {
  if (!currentEmployeeKey) return;
  if (!confirm(`Reset all saved incident/trans-code rules for ${currentEmployeeKey}? This can't be undone.`)) return;
  updateEmployee(currentEmployeeKey, { jobcode_rules: {}, trans_code_rules: { ...DEFAULT_TRANS_RULES } });
  renderRulesView(currentEmployeeKey);
});

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
  renderRulesView(null);
  try {
    setStatus(pick(FLAVOR.boot));
    pyodide = await loadPyodide();

    setStatus(pick(FLAVOR.install));
    await pyodide.loadPackage("micropip");
    const micropip = pyodide.pyimport("micropip");
    await micropip.install(["pypdf", "pdfminer.six"]);

    setStatus(pick(FLAVOR.briefing));
    for (const path of [...SHARED_ASSETS, ...LOCAL_ASSETS]) {
      const resp = await fetch(path);
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
  }
}

// --- Conversion --------------------------------------------------------

async function detectEmployeeName() {
  const nameJson = await pyodide.runPythonAsync(`
import json, traceback
def _run():
    import pdfminer_words, paycheck8_parser
    words = pdfminer_words.extract_words("/paystub.pdf")
    stub, _ = paycheck8_parser.parse_from_words(words)
    return {"ok": True, "name": stub.employee_name}
try:
    result = _run()
except Exception:
    result = {"ok": False, "error": traceback.format_exc()}
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
  try {
    setStatus(pick(FLAVOR.reading));
    const bytes = new Uint8Array(await file.arrayBuffer());
    pyodide.FS.writeFile("/paystub.pdf", bytes);

    setStatus(pick(FLAVOR.detecting));
    const detected = await detectEmployeeName();
    if (!detected.ok) {
      setResult("Could not read this paystub:\n" + detected.error, true);
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
    renderRulesView(currentEmployeeKey);
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
    pyodide.FS.writeFile("/jobcode_rules.json", new TextEncoder().encode(JSON.stringify(loadJobcodeRules(currentEmployeeKey))));
    pyodide.FS.writeFile("/trans_code_rules.json", new TextEncoder().encode(JSON.stringify(loadTransCodeRules(currentEmployeeKey))));

    setStatus(pick(FLAVOR.digging));
    const resultJson = await pyodide.runPythonAsync(`
import json, traceback

def _run():
    import pdfminer_words, paycheck8_parser, of288_filler

    words = pdfminer_words.extract_words("/paystub.pdf")
    stub, _ = paycheck8_parser.parse_from_words(words)

    jobcode_rules = json.load(open("/jobcode_rules.json"))
    trans_code_rules = json.load(open("/trans_code_rules.json"))

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
        out_paths, used_columns, grand_total = of288_filler.fill(
            stub, groups, reserved, "/OF288-Fillable.pdf", "/field_map.json", "/profile.json", "/output.pdf"
        )
    except of288_filler.ScheduleAllocationError as e:
        return {"ok": False, "error": str(e)}

    summary_lines = [
        f"Employee: {stub.employee_name}  PP{stub.pay_period_number} {stub.year} "
        f"({stub.period_start} - {stub.period_end})"
    ]
    for name, g in groups.items():
        if not g["dates"]:
            continue  # every date this group had got excluded down to nothing
        total = sum(e["hours"] for e in g["dates"].values())
        summary_lines.append(
            f"  {name} (accounting code {g['meta']['accounting_code']}): {total:g} hrs across {len(g['dates'])} day(s)"
        )
    summary_lines.append(f"Total hours (all columns): {grand_total:g}")

    return {
        "ok": True,
        "summary": "\\n".join(summary_lines),
        "out_paths": out_paths,
        "pay_period_number": stub.pay_period_number,
        "year": stub.year,
    }

try:
    result = _run()
except Exception:
    result = {"ok": False, "error": traceback.format_exc()}

json.dumps(result)
`);

    const result = JSON.parse(resultJson);

    if (!result.ok && result.unrecognized) {
      setResult("Needs your input before this can finish converting — see below.");
      showResolvePanel(result.unrecognized);
      return;
    }
    if (!result.ok) {
      setResult("Cannot convert:\n" + result.error, true);
      return;
    }

    setResult(result.summary);
    const base = `OF288_PP${result.pay_period_number}_${result.year}`;
    result.out_paths.forEach((path, i) => {
      const data = pyodide.FS.readFile(path);
      const blob = new Blob([data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = i === 0 ? `${base}.pdf` : `${base}_page${i + 1}.pdf`;
      a.textContent = "Download " + a.download;
      downloadsEl.appendChild(a);
    });
  } catch (err) {
    console.error(err);
    setResult("Error: " + err.message, true);
  } finally {
    convertBtn.disabled = false;
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
  const jobcodeRules = loadJobcodeRules(currentEmployeeKey);
  const existingByName = {};
  for (const rule of Object.values(jobcodeRules)) {
    if (rule.incident_name) existingByName[rule.incident_name] = rule;
  }
  const existingNames = Object.keys(existingByName);

  resolvePanel.innerHTML = `
    <h3>New jobcode found: ${info.jobcode}</h3>
    <div class="details">Override/accounting code on paystub: ${info.override}
Trans code: ${info.trans_code}
Hours found on:
${formatHoursByDate(info.hours_by_date)}</div>
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

  const nameInput = document.getElementById("rf_incident_name");
  nameInput.addEventListener("input", () => {
    const match = existingByName[nameInput.value];
    if (!match) return;
    for (const [id, key] of INCIDENT_FIELDS) {
      if (key !== "incident_name") document.getElementById(id).value = match[key] || "";
    }
  });

  document.getElementById("rf_save").addEventListener("click", () => {
    const values = {};
    for (const [id, key] of INCIDENT_FIELDS) {
      values[key] = document.getElementById(id).value.trim();
    }
    if (!values.incident_name || !values.accounting_code) {
      alert("Please fill in at least the incident name and accounting code.");
      return;
    }
    jobcodeRules[info.jobcode] = { include: true, group: values.incident_name, ...values };
    saveJobcodeRules(currentEmployeeKey, jobcodeRules);
    resolvePanel.style.display = "none";
    convert();
  });

  document.getElementById("rf_exclude").addEventListener("click", () => {
    jobcodeRules[info.jobcode] = { include: false, note: "Excluded via web UI — not incident time." };
    saveJobcodeRules(currentEmployeeKey, jobcodeRules);
    resolvePanel.style.display = "none";
    convert();
  });
}

function renderTransCodeResolveForm(info) {
  resolvePanel.innerHTML = `
    <h3>New trans code found: ${info.trans_code}</h3>
    <div class="details">Seen on jobcode: ${info.jobcode} (override ${info.override})
Hours found on:
${formatHoursByDate(info.hours_by_date)}</div>
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

  document.getElementById("rf_save").addEventListener("click", () => {
    const treatment = document.getElementById("rf_treatment").value;
    const transRules = loadTransCodeRules(currentEmployeeKey);
    if (treatment === "include") {
      transRules[info.trans_code] = { include: true, note: "Added via web UI" };
    } else if (treatment === "exclude") {
      transRules[info.trans_code] = { include: false, note: "Added via web UI" };
    } else {
      const flag = treatment.split("_")[1];
      transRules[info.trans_code] = { include: false, flag, note: "Added via web UI" };
    }
    saveTransCodeRules(currentEmployeeKey, transRules);
    resolvePanel.style.display = "none";
    convert();
  });
}

convertBtn.addEventListener("click", convert);
boot();
