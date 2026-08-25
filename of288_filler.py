"""Turn parsed Paycheck8 data into filled-in OF-288 PDF form fields.

Two config files drive the parts that can't be derived mechanically from
the paystub: jobcode_rules.json decides which jobcodes are incident time
at all, and which incident ("group") each one belongs to; trans_code_rules
decides whether a trans code's hours count, get excluded (e.g. hazard pay,
which shows as an "H" flag on the real worked-hours row instead of its own
line), or something else. Unrecognized codes raise an error rather than
silently guessing, since this is payroll-adjacent data.
"""
import json
from itertools import permutations

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, RectangleObject

TYPE_OF_EMPLOYMENT_EXPORT_VALUES = {"Casual": "1", "Federal": "0", "Other": "2"}

# Incident metadata (items 8-12) that a jobcode rule can carry, on top of
# which group it belongs to. None of this is derivable from the paystub —
# it comes from the resource order — so it's whatever the jobcode_rules
# entry (or a trans_overrides entry) says, defaulting to blank.
INCIDENT_META_FIELDS = [
    "accounting_code", "incident_name", "incident_order_number",
    "fire_code", "resource_request_number", "position_code",
]

# The template's text fields default to a 5.5-6.8pt Tahoma appearance, and
# the template's font resources (Helv, Tahoma, ZaDb) have no bold variant.
# We fill with a standard Helvetica-Bold instead — one of the 14 base PDF
# fonts, so it renders correctly in any viewer with no embedding needed —
# registered into the AcroForm's resource dict by _ensure_bold_font().
# Grid cells (Mo/Day/Start/Stop/Hours) get their boxes stretched by
# GRID_ROW_PAD (see _enlarge_grid_rects) to make room for a bigger font
# than the original tight 5.5pt box allowed.
FONT_NAME = "/HeBo"
GRID_FONT_SIZE = 10.0
TOTALS_FONT_SIZE = 7.5  # Year / Total Hours boxes are only 6.8pt tall
HEADER_FONT_SIZE = 8.5


def _t(text, size=HEADER_FONT_SIZE):
    return (text, FONT_NAME, size)


def _ensure_bold_font(writer):
    """Register standard Helvetica-Bold as a fillable font resource. The
    template only ships Helv/Tahoma/ZaDb, none bold, so this adds one
    rather than trying to fake bold with the existing (non-bold) fonts.
    """
    font_dict = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica-Bold"),
        NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
    })
    font_ref = writer._add_object(font_dict)

    acro_form = writer._root_object["/AcroForm"]
    dr = acro_form["/DR"]
    font_resources = dr["/Font"]
    font_resources[NameObject(FONT_NAME)] = font_ref


class UnrecognizedCodeError(ValueError):
    """Carries structured info (not just a message) so a caller — like the
    browser UI — can build a form around exactly what's unrecognized,
    instead of parsing an error string.
    """
    def __init__(self, message, *, kind, jobcode, override, trans_code, hours_by_date):
        super().__init__(message)
        self.kind = kind  # "jobcode" or "trans_code"
        self.jobcode = jobcode
        self.override = override
        self.trans_code = trans_code
        self.hours_by_date = hours_by_date  # {date: hours} for context


class ScheduleAllocationError(ValueError):
    """Raised when a date's clock-in/out segments can't be cleanly divided
    among that date's incident groups by matching hour totals. Rather than
    guess at Start/Stop times for payroll data, surface this for manual
    review.
    """
    pass


def _load_json(path):
    with open(path) as fh:
        return json.load(fh)


def build_groups(paystub, jobcode_rules, trans_code_rules):
    """Group paystub line items into per-incident daily hours.

    A jobcode can carry a "trans_overrides" map for cases where a specific
    trans code on that jobcode needs different handling than the global
    trans_code_rules — e.g. admin leave (trans 66) taken while embedded in
    an incident assignment gets attributed to that incident instead of
    excluded, which depends on assignment dates the paystub doesn't carry,
    so it's a per-case override rather than a general rule.

    Also returns `reserved`: {date: [(key, hours), ...]} for excluded lines
    (e.g. the always-excluded home-unit jobcode, or admin leave). These
    still occupy real clock time that day even though they produce no
    OF-288 row, which matters when allocate_rows has to figure out which
    clock segment belongs to which group — an excluded block can sit
    chronologically between two tracked ones.

    Returns (groups, reserved) where
    groups = {group_name: {"meta": {...incident fields...}, "dates": {date: {"hours": float, "flags": set[str]}}}}
    """
    groups = {}
    reserved = {}
    for line in paystub.lines:
        job_cfg = jobcode_rules.get(line.jobcode)
        if job_cfg is None:
            raise UnrecognizedCodeError(
                f"Unrecognized jobcode '{line.jobcode}' (override {line.override}, "
                f"trans {line.trans_code}). Add it to jobcode_rules.json before converting.",
                kind="jobcode", jobcode=line.jobcode, override=line.override,
                trans_code=line.trans_code, hours_by_date=line.hours_by_date,
            )

        def _reserve(key):
            for d, hours in line.hours_by_date.items():
                reserved.setdefault(d, []).append((key, hours))

        override = job_cfg.get("trans_overrides", {}).get(line.trans_code)
        if override is not None:
            trans_cfg = override
            source_cfg = {**job_cfg, **override}
            group_name = source_cfg.get("group")
        else:
            if not job_cfg["include"]:
                _reserve(line.jobcode)
                continue
            trans_cfg = trans_code_rules.get(line.trans_code)
            if trans_cfg is None:
                raise UnrecognizedCodeError(
                    f"Unrecognized trans code '{line.trans_code}' on jobcode '{line.jobcode}'. "
                    f"Add it to trans_code_rules.json before converting.",
                    kind="trans_code", jobcode=line.jobcode, override=line.override,
                    trans_code=line.trans_code, hours_by_date=line.hours_by_date,
                )
            source_cfg = job_cfg
            group_name = job_cfg["group"]

        meta = {field: source_cfg.get(field, "") for field in INCIDENT_META_FIELDS}

        flag = trans_cfg.get("flag")
        if not trans_cfg.get("include") and not flag:
            _reserve(f"{line.jobcode}#{line.trans_code}")
            continue  # contributes nothing to the OF-288 (e.g. admin leave)

        group = groups.setdefault(group_name, {"meta": meta, "dates": {}})
        for d, hours in line.hours_by_date.items():
            entry = group["dates"].setdefault(d, {"hours": 0.0, "flags": set()})
            if trans_cfg.get("include"):
                entry["hours"] += hours
            if flag:
                entry["flags"].add(flag)

    # drop any date left with zero hours and no flag (can happen when a
    # date's only contributions were later found to net to nothing)
    for group in groups.values():
        for d in [d for d, e in group["dates"].items() if e["hours"] <= 0 and not e["flags"]]:
            del group["dates"][d]

    return groups, reserved


TOLERANCE = 1e-6


def _consume_in_order(segments, ordered_items):
    """Try to consume `segments` (in chronological order) exactly matching
    each (key, target_hours) item's target in turn, using whole segments
    only. Returns {key: [ClockSegment, ...]} if every item's target was hit
    exactly and every segment got used, else None.
    """
    seg_idx = 0
    consumed_by_key = {}
    for key, target in ordered_items:
        consumed = []
        total = 0.0
        while total < target - TOLERANCE:
            if seg_idx >= len(segments):
                return None
            seg = segments[seg_idx]
            consumed.append(seg)
            total += seg.hours
            seg_idx += 1
        if abs(total - target) > TOLERANCE:
            return None
        consumed_by_key[key] = consumed
    if seg_idx != len(segments):
        return None
    return consumed_by_key


def _resolve_day(segments, needs, blockers):
    """Figure out which of a date's clock segments belong to which need.

    `needs` are (group_name, target_hours) pairs we actually want rows for;
    `blockers` are (key, target_hours) pairs for excluded jobcodes/trans
    codes that still occupy real clock time that day but produce no output.
    Both are needed because an excluded block can sit chronologically
    between two tracked incidents (e.g. someone works incident A, then
    their home-unit default duty, then incident B, same day) — the file
    order groups were first seen in doesn't reliably predict that.

    Tries the natural (file) order first since that covers the vast
    majority of cases cheaply, then falls back to searching other
    orderings of the (small, per-day) item list. Returns
    {group_name: [ClockSegment, ...]} for `needs` only, or None if no
    ordering divides the segments evenly.
    """
    items = needs + blockers
    result = _consume_in_order(segments, items)
    if result is None:
        for perm in permutations(items):
            if perm == tuple(items):
                continue  # already tried above
            result = _consume_in_order(segments, list(perm))
            if result is not None:
                break
    if result is None:
        return None
    return {name: result[name] for name, _ in needs}


def allocate_rows(paystub, groups, reserved):
    """Turn each group's per-date target hours into actual Start/Stop rows
    by working out which of that date's real clock-in/out segments belong
    to it (see _resolve_day), then merging contiguous segments (no gap
    between stop and next start) into a single row, matching how the real
    form is filled out.

    Returns {group_name: [(date, start, stop, hours_float, flag_suffix), ...]}
    """
    group_order = list(groups.keys())  # first-seen order from build_groups
    rows_by_group = {name: [] for name in groups}

    all_dates = sorted({d for g in groups.values() for d in g["dates"]})

    for d in all_dates:
        segments = list(paystub.clock_segments.get(d, []))
        needs = [(name, groups[name]["dates"][d]["hours"]) for name in group_order if d in groups[name]["dates"]]
        blockers = reserved.get(d, [])

        consumed_by_name = _resolve_day(segments, needs, blockers)
        if consumed_by_name is None:
            names = ", ".join(name for name, _ in needs)
            raise ScheduleAllocationError(
                f"On {d}, could not find any way to divide that day's clock-in/out segments "
                f"to match the expected hours for {names}. This date needs manual review."
            )

        for name, target in needs:
            entry = groups[name]["dates"][d]
            consumed = consumed_by_name[name]

            # merge contiguous segments (stop == next start) into one row
            merged = []
            cur_start, cur_stop, cur_hours = consumed[0].start, consumed[0].stop, consumed[0].hours
            for seg in consumed[1:]:
                if seg.start == cur_stop:
                    cur_stop, cur_hours = seg.stop, cur_hours + seg.hours
                else:
                    merged.append((cur_start, cur_stop, cur_hours))
                    cur_start, cur_stop, cur_hours = seg.start, seg.stop, seg.hours
            merged.append((cur_start, cur_stop, cur_hours))

            flag_suffix = "".join(sorted(entry["flags"]))
            for start, stop, hours in merged:
                rows_by_group[name].append((d, start, stop, hours, flag_suffix))

    return rows_by_group


COLUMN_LETTERS = ["A", "B", "C", "D"]


def _plan_column_assignments(groups, rows_by_group, grid_len):
    """Split each group's rows into column-sized chunks, in group order.
    Each chunk knows whether it's the first chunk of its group overall
    (needs the accounting code shown) — page-local "same as column"
    handling is resolved later once chunks are assigned to physical pages.
    """
    assignments = []
    for group_name, group in groups.items():
        remaining = rows_by_group[group_name]
        while remaining:
            chunk, remaining = remaining[:grid_len], remaining[grid_len:]
            assignments.append({
                "group": group_name,
                "meta": group["meta"],
                "rows": chunk,
            })
    return assignments


GRID_ROW_PAD = 3.0  # pt added above and below each grid cell's original box


def _full_annotation_name(obj):
    parts = []
    name = obj.get("/T")
    if name:
        parts.insert(0, str(name))
    p = obj.get("/Parent")
    while p is not None:
        pobj = p.get_object()
        pt = pobj.get("/T")
        if pt:
            parts.insert(0, str(pt))
        p = pobj.get("/Parent")
    return ".".join(parts)


def _enlarge_grid_rects(writer, field_map):
    """The grid cells (Mo/Day/Start/Stop/Hours) are only 5.5pt tall boxes,
    but rows are spaced ~12.7pt apart, so most of that height is unused
    whitespace between rows. Stretch each cell's box into that margin so a
    bigger font fits without clipping.
    """
    grid_field_names = set()
    for col in COLUMN_LETTERS:
        for row in field_map["columns"][col]["grid"]:
            grid_field_names.update(row.values())

    for annot in writer.pages[0]["/Annots"]:
        obj = annot.get_object()
        if _full_annotation_name(obj) not in grid_field_names:
            continue
        x0, y0, x1, y1 = (float(v) for v in obj["/Rect"])
        obj[NameObject("/Rect")] = RectangleObject((x0, y0 - GRID_ROW_PAD, x1, y1 + GRID_ROW_PAD))


def _fill_one_page(paystub, profile, field_map, page_assignments, template_path):
    values = {}
    checkboxes = {}

    top = field_map["top"]
    values[top["1_hired_at"]] = _t(profile.get("1_hired_at", ""))
    values[top["2_employee_common_identifier"]] = _t(profile.get("2_employee_common_identifier", ""))
    values[top["4_hiring_unit_name"]] = _t(profile.get("4_hiring_unit_name", ""))
    values[top["5_name"]] = _t(paystub.employee_name.title())
    values[top["6_hiring_unit_phone"]] = _t(profile.get("6_hiring_unit_phone", ""))
    values[top["7_hiring_unit_fax"]] = _t(profile.get("7_hiring_unit_fax", ""))

    page_total = 0.0
    first_col_on_page = {}  # group_name -> column letter, for same-as-column refs on this sheet

    for col, assignment in zip(COLUMN_LETTERS, page_assignments):
        group_name = assignment["group"]
        col_map = field_map["columns"][col]
        grid = col_map["grid"]

        if group_name not in first_col_on_page:
            first_col_on_page[group_name] = col
            meta = assignment["meta"]
            values[col_map["8_incident_name"]] = _t(meta.get("incident_name", ""))
            values[col_map["9_incident_order_number"]] = _t(meta.get("incident_order_number", ""))
            values[col_map["10_fire_code"]] = _t(meta.get("fire_code", ""))
            values[col_map["11_resource_request_number"]] = _t(meta.get("resource_request_number", ""))
            values[col_map["12_position_code"]] = _t(meta.get("position_code", ""))
            values[col_map["15_accounting_code"]] = _t(meta.get("accounting_code", ""))
        else:
            checkboxes[col] = first_col_on_page[group_name]

        col_total = 0.0
        for field_row, (d, start, stop, hours, flag_suffix) in zip(grid, assignment["rows"]):
            # flag goes on the left (e.g. "H  6.5"), clearly separated from
            # the number rather than butted up against it
            hours_str = f"{flag_suffix}  {hours:g}" if flag_suffix else f"{hours:g}"
            values[field_row["mo"]] = _t(str(d.month), GRID_FONT_SIZE)
            values[field_row["day"]] = _t(str(d.day), GRID_FONT_SIZE)
            values[field_row["start"]] = _t(start, GRID_FONT_SIZE)
            values[field_row["stop"]] = _t(stop, GRID_FONT_SIZE)
            values[field_row["hours"]] = _t(hours_str, GRID_FONT_SIZE)
            col_total += hours

        values[col_map["16_year"]] = _t(str(paystub.year), TOTALS_FONT_SIZE)
        values[col_map["16_total_hours"]] = _t(f"{col_total:g}", TOTALS_FONT_SIZE)
        page_total += col_total

    values[field_map["item17_total_hours"]] = _t(f"{page_total:g}", TOTALS_FONT_SIZE)

    radio_field = field_map["radio_type_of_employment"]
    # profile.get(..., "Federal") only falls back when the key is *missing*,
    # not when it's present-but-empty (e.g. a blank/unselected form field),
    # so guard against that case too rather than KeyError on a bad value.
    employment_type = profile.get("3_type_of_employment") or "Federal"
    values[radio_field] = f"/{TYPE_OF_EMPLOYMENT_EXPORT_VALUES.get(employment_type, TYPE_OF_EMPLOYMENT_EXPORT_VALUES['Federal'])}"

    same_as_map = field_map["same_as_checkboxes"]
    for col, ref_col in checkboxes.items():
        values[same_as_map[col][ref_col]] = "/1"

    reader = PdfReader(template_path)
    writer = PdfWriter()
    writer.append(reader)
    _ensure_bold_font(writer)
    _enlarge_grid_rects(writer, field_map)
    writer.update_page_form_field_values(writer.pages[0], values, auto_regenerate=False)

    return writer, page_total


def fill(paystub, groups, reserved, template_path, field_map_path, profile_path, out_path):
    """Fills the OF-288 template, one physical sheet per up-to-4 columns
    needed. If the pay period's incidents/rows need more than 4 column-starts
    total, extra sheets are written alongside out_path (e.g. "..._page2.pdf"),
    matching how this is handled on paper — each sheet repeats the employee
    header and stands alone. A group's own "Same as Column" reference only
    ever points at a column on its own sheet.
    """
    field_map = _load_json(field_map_path)
    profile = _load_json(profile_path)
    rows_by_group = allocate_rows(paystub, groups, reserved)
    grid_len = len(field_map["columns"]["A"]["grid"])

    assignments = _plan_column_assignments(groups, rows_by_group, grid_len)
    pages = [assignments[i:i + 4] for i in range(0, len(assignments), 4)] or [[]]

    grand_total = 0.0
    out_paths = []
    base, ext = out_path.rsplit(".", 1) if "." in out_path else (out_path, "pdf")

    for page_num, page_assignments in enumerate(pages, start=1):
        writer, page_total = _fill_one_page(paystub, profile, field_map, page_assignments, template_path)
        page_path = out_path if page_num == 1 else f"{base}_page{page_num}.{ext}"
        with open(page_path, "wb") as fh:
            writer.write(fh)
        out_paths.append(page_path)
        grand_total += page_total

    used_columns = [a["group"] + ":" + col for page in pages for col, a in zip(COLUMN_LETTERS, page)]
    return out_paths, used_columns, grand_total
