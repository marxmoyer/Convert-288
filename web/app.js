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

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

// Assets shared with the desktop CLI live one directory up; pdfminer_words.py
// is browser-only (replaces pdfplumber, which can't install under Pyodide).
// profile.json / jobcode_rules.json / trans_code_rules.json are NOT fetched
// from the repo — they're personal to each user, kept in this browser's
// localStorage only, and written into the Pyodide filesystem fresh before
// every conversion.
const SHARED_ASSETS = [
  "../paycheck8_parser.py",
  "../of288_filler.py",
  "../field_map.json",
  "../OF288-Fillable.pdf",
];
const LOCAL_ASSETS = ["pdfminer_words.py"];

// --- Profile (name/hiring-unit fields) ---------------------------------

const PROFILE_STORAGE_KEY = "of288_profile_v1";
const PROFILE_FIELDS = {
  p_hired_at: "1_hired_at",
  p_eci: "2_employee_common_identifier",
  p_type: "3_type_of_employment",
  p_unit_name: "4_hiring_unit_name",
  p_phone: "6_hiring_unit_phone",
  p_fax: "7_hiring_unit_fax",
};

function loadProfileIntoForm() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "{}");
  } catch {
    // ignore corrupt/missing storage, just start blank
  }
  for (const [inputId, profileKey] of Object.entries(PROFILE_FIELDS)) {
    if (saved[profileKey] !== undefined) {
      document.getElementById(inputId).value = saved[profileKey];
    }
  }
}

function readProfileFromForm() {
  const profile = {};
  for (const [inputId, profileKey] of Object.entries(PROFILE_FIELDS)) {
    profile[profileKey] = document.getElementById(inputId).value.trim();
  }
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — non-fatal
  }
  return profile;
}

// --- Jobcode / trans-code rules (per-browser, editable) -----------------

const JOBCODE_RULES_KEY = "of288_jobcode_rules_v1";
const TRANS_CODE_RULES_KEY = "of288_trans_code_rules_v1";

// Trans codes 01/21/14/66 look like agency-standard Paycheck8 definitions
// rather than anything personal, so every new user starts with these
// pre-filled — editable/removable like anything else in localStorage.
const DEFAULT_TRANS_RULES = {
  "01": { include: true, note: "Regular hours" },
  "21": { include: true, note: "Overtime hours" },
  "14": { include: false, flag: "H", note: "Hazard pay differential — flags the matching worked-hours row with H instead of adding separate hours" },
  "66": { include: false, note: "Administrative leave — not incident work, excluded entirely (no flag)" },
};

function loadJobcodeRules() {
  try {
    return JSON.parse(localStorage.getItem(JOBCODE_RULES_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveJobcodeRules(rules) {
  localStorage.setItem(JOBCODE_RULES_KEY, JSON.stringify(rules));
  renderRulesView();
}

function loadTransCodeRules() {
  try {
    const raw = localStorage.getItem(TRANS_CODE_RULES_KEY);
    if (raw === null) {
      saveTransCodeRules(DEFAULT_TRANS_RULES);
      return { ...DEFAULT_TRANS_RULES };
    }
    return JSON.parse(raw);
  } catch {
    return { ...DEFAULT_TRANS_RULES };
  }
}

function saveTransCodeRules(rules) {
  localStorage.setItem(TRANS_CODE_RULES_KEY, JSON.stringify(rules));
  renderRulesView();
}

function renderRulesView() {
  jobcodeRulesView.textContent = JSON.stringify(loadJobcodeRules(), null, 2) || "(none yet)";
  transCodeRulesView.textContent = JSON.stringify(loadTransCodeRules(), null, 2);
}

resetRulesBtn.addEventListener("click", () => {
  if (!confirm("Reset all your saved incident/trans-code rules? This can't be undone.")) return;
  localStorage.removeItem(JOBCODE_RULES_KEY);
  localStorage.removeItem(TRANS_CODE_RULES_KEY);
  loadTransCodeRules(); // re-seeds defaults
  renderRulesView();
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
    setStatus("Please drop a PDF file.", true);
  }
});

// --- Pyodide boot ----------------------------------------------------------

let pyodide;

async function boot() {
  loadProfileIntoForm();
  renderRulesView();
  try {
    setStatus("Downloading Python runtime (Pyodide)…");
    pyodide = await loadPyodide();

    setStatus("Installing pypdf + pdfminer.six…");
    await pyodide.loadPackage("micropip");
    const micropip = pyodide.pyimport("micropip");
    await micropip.install(["pypdf", "pdfminer.six"]);

    setStatus("Loading conversion logic…");
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

    setStatus("Ready. Choose a paystub PDF to convert.");
    fileInput.disabled = false;
    convertBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus("Failed to start: " + err.message, true);
  }
}

// --- Conversion --------------------------------------------------------

async function convert() {
  const file = fileInput.files[0];
  if (!file) {
    setStatus("Choose a paystub PDF first.", true);
    return;
  }

  resolvePanel.style.display = "none";
  downloadsEl.innerHTML = "";
  convertBtn.disabled = true;
  try {
    setStatus("Reading file…");
    const bytes = new Uint8Array(await file.arrayBuffer());
    pyodide.FS.writeFile("/paystub.pdf", bytes);

    const profile = readProfileFromForm();
    pyodide.FS.writeFile("/profile.json", new TextEncoder().encode(JSON.stringify(profile)));
    pyodide.FS.writeFile("/jobcode_rules.json", new TextEncoder().encode(JSON.stringify(loadJobcodeRules())));
    pyodide.FS.writeFile("/trans_code_rules.json", new TextEncoder().encode(JSON.stringify(loadTransCodeRules())));

    setStatus("Parsing paystub…");
    const resultJson = await pyodide.runPythonAsync(`
import json, traceback

def _run():
    import pdfminer_words, paycheck8_parser, of288_filler

    words = pdfminer_words.extract_words("/paystub.pdf")
    stub, _ = paycheck8_parser.parse_from_words(words)

    jobcode_rules = json.load(open("/jobcode_rules.json"))
    trans_code_rules = json.load(open("/trans_code_rules.json"))

    try:
        groups = of288_filler.build_groups(stub, jobcode_rules, trans_code_rules)
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
            stub, groups, "/OF288-Fillable.pdf", "/field_map.json", "/profile.json", "/output.pdf"
        )
    except of288_filler.ScheduleAllocationError as e:
        return {"ok": False, "error": str(e)}

    summary_lines = [
        f"Employee: {stub.employee_name}  PP{stub.pay_period_number} {stub.year} "
        f"({stub.period_start} - {stub.period_end})"
    ]
    for name, g in groups.items():
        total = sum(e["hours"] for e in g["dates"].values())
        summary_lines.append(
            f"  {name} (accounting code {g['accounting_code']}): {total:g} hrs across {len(g['dates'])} day(s)"
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
      setStatus("Needs your input before this can finish converting — see below.");
      showResolvePanel(result.unrecognized);
      return;
    }
    if (!result.ok) {
      setStatus("Cannot convert:\n" + result.error, true);
      return;
    }

    setStatus(result.summary);
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
    setStatus("Error: " + err.message, true);
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

function renderJobcodeResolveForm(info) {
  const jobcodeRules = loadJobcodeRules();
  const existingGroups = [...new Set(Object.values(jobcodeRules).map((r) => r.group).filter(Boolean))];

  resolvePanel.innerHTML = `
    <h3>New jobcode found: ${info.jobcode}</h3>
    <div class="details">Override/accounting code on paystub: ${info.override}
Trans code: ${info.trans_code}
Hours found on:
${formatHoursByDate(info.hours_by_date)}</div>
    <p class="hint">What incident does this belong to? (If it's the same incident as one you already named, type that exact name again — the accounting code will fill in for you.)</p>
    <div class="row">
      <label>Incident name
        <input id="rf_group" list="rf_group_list" placeholder="e.g. Aspen Acres">
        <datalist id="rf_group_list">${existingGroups.map((g) => `<option value="${g}">`).join("")}</datalist>
      </label>
      <label>Accounting code
        <input id="rf_acct" placeholder="e.g. 1542">
      </label>
    </div>
    <div class="actions">
      <button id="rf_save">Save & continue</button>
      <button id="rf_exclude" class="secondary">This isn't incident time — exclude it</button>
    </div>
  `;

  const groupInput = document.getElementById("rf_group");
  const acctInput = document.getElementById("rf_acct");
  groupInput.addEventListener("input", () => {
    const match = Object.values(jobcodeRules).find((r) => r.group === groupInput.value);
    if (match) acctInput.value = match.accounting_code;
  });

  document.getElementById("rf_save").addEventListener("click", () => {
    const group = groupInput.value.trim();
    const acct = acctInput.value.trim();
    if (!group || !acct) {
      alert("Please fill in both the incident name and accounting code.");
      return;
    }
    jobcodeRules[info.jobcode] = { include: true, group, accounting_code: acct };
    saveJobcodeRules(jobcodeRules);
    resolvePanel.style.display = "none";
    convert();
  });

  document.getElementById("rf_exclude").addEventListener("click", () => {
    jobcodeRules[info.jobcode] = { include: false, note: "Excluded via web UI — not incident time." };
    saveJobcodeRules(jobcodeRules);
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
  });
}

convertBtn.addEventListener("click", convert);
boot();
