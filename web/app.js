import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.5/full/pyodide.mjs";

const statusEl = document.getElementById("status");
const fileInput = document.getElementById("fileInput");
const convertBtn = document.getElementById("convertBtn");
const downloadsEl = document.getElementById("downloads");

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

// Assets shared with the desktop CLI live one directory up; pdfminer_words.py
// is browser-only (replaces pdfplumber, which can't install under Pyodide).
// profile.json is NOT fetched — it holds personal info, so it's collected
// from the form below (saved to localStorage, never uploaded anywhere) and
// written into the Pyodide filesystem fresh on every conversion instead.
const SHARED_ASSETS = [
  "../paycheck8_parser.py",
  "../of288_filler.py",
  "../field_map.json",
  "../jobcode_rules.json",
  "../trans_code_rules.json",
  "../OF288-Fillable.pdf",
];
const LOCAL_ASSETS = ["pdfminer_words.py"];

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
    // localStorage unavailable (private mode, quota, etc.) — non-fatal,
    // conversion still works, it just won't be remembered next visit
  }
  return profile;
}

let pyodide;

async function boot() {
  loadProfileIntoForm();
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

async function convert() {
  const file = fileInput.files[0];
  if (!file) {
    setStatus("Choose a paystub PDF first.", true);
    return;
  }

  downloadsEl.innerHTML = "";
  convertBtn.disabled = true;
  try {
    setStatus("Reading file…");
    const bytes = new Uint8Array(await file.arrayBuffer());
    pyodide.FS.writeFile("/paystub.pdf", bytes);

    const profile = readProfileFromForm();
    pyodide.FS.writeFile("/profile.json", new TextEncoder().encode(JSON.stringify(profile)));

    setStatus("Parsing paystub…");
    const resultJson = await pyodide.runPythonAsync(`
import json, traceback

def _run():
    import pdfminer_words, paycheck8_parser, of288_filler

    def load_rules(path):
        data = json.load(open(path))
        data.pop("_comment", None)
        return data

    words = pdfminer_words.extract_words("/paystub.pdf")
    stub, _ = paycheck8_parser.parse_from_words(words)

    jobcode_rules = load_rules("/jobcode_rules.json")
    trans_code_rules = load_rules("/trans_code_rules.json")

    try:
        groups = of288_filler.build_groups(stub, jobcode_rules, trans_code_rules)
    except of288_filler.UnrecognizedCodeError as e:
        return {"ok": False, "error": str(e)}

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

convertBtn.addEventListener("click", convert);
boot();
