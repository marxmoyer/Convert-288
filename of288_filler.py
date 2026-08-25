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

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, RectangleObject

TYPE_OF_EMPLOYMENT_EXPORT_VALUES = {"Casual": "1", "Federal": "0", "Other": "2"}

# The template's text fields default to a 5.5-6.8pt Tahoma appearance.
# Grid cells (Mo/Day/Start/Stop/Hours) get their boxes stretched by
# GRID_ROW_PAD (see _enlarge_grid_rects) to make room for a bigger font
# than the original tight 5.5pt box allowed.
FONT_NAME = "/Tahoma"
GRID_FONT_SIZE = 9.0
TOTALS_FONT_SIZE = 6.5  # Year / Total Hours boxes are only 6.8pt tall
HEADER_FONT_SIZE = 7.5


def _t(text, size=HEADER_FONT_SIZE):
    return (text, FONT_NAME, size)


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

    Returns {group_name: {"accounting_code": str, "dates": {date: {"hours": float, "flags": set[str]}}}}
    """
    groups = {}
    for line in paystub.lines:
        job_cfg = jobcode_rules.get(line.jobcode)
        if job_cfg is None:
            raise UnrecognizedCodeError(
                f"Unrecognized jobcode '{line.jobcode}' (override {line.override}, "
                f"trans {line.trans_code}). Add it to jobcode_rules.json before converting.",
                kind="jobcode", jobcode=line.jobcode, override=line.override,
                trans_code=line.trans_code, hours_by_date=line.hours_by_date,
            )

        override = job_cfg.get("trans_overrides", {}).get(line.trans_code)
        if override is not None:
            trans_cfg = override
            group_name = override.get("group", job_cfg.get("group"))
            accounting_code = override.get("accounting_code", job_cfg.get("accounting_code"))
        else:
            if not job_cfg["include"]:
                continue
            trans_cfg = trans_code_rules.get(line.trans_code)
            if trans_cfg is None:
                raise UnrecognizedCodeError(
                    f"Unrecognized trans code '{line.trans_code}' on jobcode '{line.jobcode}'. "
                    f"Add it to trans_code_rules.json before converting.",
                    kind="trans_code", jobcode=line.jobcode, override=line.override,
                    trans_code=line.trans_code, hours_by_date=line.hours_by_date,
                )
            group_name = job_cfg["group"]
            accounting_code = job_cfg["accounting_code"]

        flag = trans_cfg.get("flag")
        if not trans_cfg.get("include") and not flag:
            continue  # contributes nothing to the OF-288 (e.g. admin leave)

        group = groups.setdefault(group_name, {"accounting_code": accounting_code, "dates": {}})
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

    return groups


TOLERANCE = 1e-6


def allocate_rows(paystub, groups):
    """Turn each group's per-date target hours into actual Start/Stop rows
    by walking that date's real clock-in/out segments in order.

    When a date belongs to only one group, all of that date's segments are
    consumed and contiguous ones (no gap between stop and next start) merge
    into a single row, matching how the real form is filled out. When a
    date is split across multiple groups (e.g. two different incidents the
    same day), segments are consumed in chronological order into each
    group in turn until that group's known target hours are exactly used
    up — this only works because segment boundaries line up with incident
    boundaries in practice; if they don't divide evenly, that's surfaced as
    an error rather than guessed at.

    Returns {group_name: [(date, start, stop, hours_float, flag_suffix), ...]}
    """
    group_order = list(groups.keys())  # first-seen order from build_groups
    rows_by_group = {name: [] for name in groups}

    all_dates = sorted({d for g in groups.values() for d in g["dates"]})

    for d in all_dates:
        segments = list(paystub.clock_segments.get(d, []))
        needs = [(name, groups[name]["dates"][d]) for name in group_order if d in groups[name]["dates"]]

        seg_idx = 0
        for name, entry in needs:
            target = entry["hours"]
            consumed = []
            total = 0.0
            while total < target - TOLERANCE:
                if seg_idx >= len(segments):
                    raise ScheduleAllocationError(
                        f"On {d}, clock-in/out segments run out before reaching {name}'s "
                        f"expected {target:g} hours (only found {total:g}h of clock time). "
                        f"This date needs manual review."
                    )
                seg = segments[seg_idx]
                consumed.append(seg)
                total += seg.hours
                seg_idx += 1
            if abs(total - target) > TOLERANCE:
                raise ScheduleAllocationError(
                    f"On {d}, clock-in/out segments for {name} sum to {total:g}h but "
                    f"{target:g}h was expected from the daily-hours breakdown. "
                    f"This date needs manual review."
                )

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
                "accounting_code": group["accounting_code"],
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
            values[col_map["15_accounting_code"]] = _t(assignment["accounting_code"])
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
    values[radio_field] = f"/{TYPE_OF_EMPLOYMENT_EXPORT_VALUES[profile.get('3_type_of_employment', 'Federal')]}"

    same_as_map = field_map["same_as_checkboxes"]
    for col, ref_col in checkboxes.items():
        values[same_as_map[col][ref_col]] = "/1"

    reader = PdfReader(template_path)
    writer = PdfWriter()
    writer.append(reader)
    _enlarge_grid_rects(writer, field_map)
    writer.update_page_form_field_values(writer.pages[0], values, auto_regenerate=False)

    return writer, page_total


def fill(paystub, groups, template_path, field_map_path, profile_path, out_path):
    """Fills the OF-288 template, one physical sheet per up-to-4 columns
    needed. If the pay period's incidents/rows need more than 4 column-starts
    total, extra sheets are written alongside out_path (e.g. "..._page2.pdf"),
    matching how this is handled on paper — each sheet repeats the employee
    header and stands alone. A group's own "Same as Column" reference only
    ever points at a column on its own sheet.
    """
    field_map = _load_json(field_map_path)
    profile = _load_json(profile_path)
    rows_by_group = allocate_rows(paystub, groups)
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
