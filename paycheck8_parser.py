"""Parse a USDA Forest Service Paycheck8 'Show Current T&A' PDF into
structured per-line, per-date hours data.

Geometry-based extraction: the PDF has no reliable text-column order for
blank table cells, so numeric values are bucketed to the nearest date
column by x-position instead of relying on left-to-right text order.

Word extraction is decoupled from the parsing logic below (parse_from_words)
so the CLI can use pdfplumber while the browser build (which can't install
pdfplumber's pypdfium2 dependency under Pyodide) uses a pdfminer.six-based
extractor instead — both just need to produce a list of
{"text": str, "x0": float, "top": float} dicts for the first page.
"""
import re
from dataclasses import dataclass, field
from datetime import date

OVERRIDE_RE = re.compile(r"^\d{3,6}$")
DATE_HDR_RE = re.compile(r"^(\d{1,2})/(\d{1,2})$")
TIME_RE = re.compile(r"^\d{4}$")
FROM_TO_X_MIN, FROM_TO_X_MAX = 138, 146

# Real per-day values land within ~8pt of their date column's x0 (numbers
# are right-aligned in narrower cells than the header labels). Week/grand
# total values sit much further right of the last date column in a week
# (~20pt+), so a mid-way cutoff cleanly separates the two without needing
# to locate the "Total" header labels explicitly.
MAX_COLUMN_DISTANCE = 12


class TotalHoursMismatchError(ValueError):
    """Raised when the sum of every hours value actually extracted from the
    daily-hours grid doesn't match the paystub's own printed 'Total Hours'
    field. This is a parsing-completeness check, not a business-logic one —
    it catches a row the geometry-based extraction missed (or double-
    counted) due to a layout quirk, before that silently becomes an
    under-reported OF-288 with no warning.
    """
    def __init__(self, message, *, printed_total, captured_total):
        super().__init__(message)
        self.printed_total = printed_total
        self.captured_total = captured_total


@dataclass
class PaystubLine:
    override: str
    jobcode: str
    trans_code: str
    hours_by_date: dict = field(default_factory=dict)  # date -> float


@dataclass
class ClockSegment:
    start: str  # military time, e.g. "0800"
    stop: str
    hours: float


@dataclass
class Paystub:
    employee_name: str
    year: int
    pay_period_number: int
    period_start: date
    period_end: date
    total_hours: float
    lines: list
    clock_segments: dict = field(default_factory=dict)  # date -> list[ClockSegment], chronological


def _nearest_column(x0, columns):
    nearest_date, nearest_x0 = min(columns, key=lambda c: abs(c[1] - x0))
    if abs(nearest_x0 - x0) > MAX_COLUMN_DISTANCE:
        return None
    return nearest_date


def _hhmm_to_minutes(s):
    return int(s[:2]) * 60 + int(s[2:])


def _segment_hours(start, stop):
    start_min = _hhmm_to_minutes(start)
    stop_min = _hhmm_to_minutes(stop)
    if stop_min < start_min:
        stop_min += 24 * 60  # overnight shift crossing midnight (e.g. 2200 -> 0600)
    return (stop_min - start_min) / 60


def _extract_clock_segments(words, columns):
    """The 'Clock Hours' table is a stack of From/To row-pairs (one pair per
    on-shift block that day: regular hours, then any later blocks split off
    by a rate/leave-category change). Each row's values bucket to date
    columns the same way as the daily-hours table.
    """
    from_tops = sorted(
        {w["top"] for w in words if w["text"] == "From" and FROM_TO_X_MIN <= w["x0"] <= FROM_TO_X_MAX}
    )
    to_tops = sorted(
        {w["top"] for w in words if w["text"] == "To" and FROM_TO_X_MIN <= w["x0"] <= FROM_TO_X_MAX}
    )

    segments_by_date = {}
    for from_top, to_top in zip(from_tops, to_tops):
        from_vals = {}
        for w in words:
            if abs(w["top"] - from_top) < 1 and TIME_RE.match(w["text"]):
                d = _nearest_column(w["x0"], columns)
                if d is not None:
                    from_vals[d] = w["text"]
        to_vals = {}
        for w in words:
            if abs(w["top"] - to_top) < 1 and TIME_RE.match(w["text"]):
                d = _nearest_column(w["x0"], columns)
                if d is not None:
                    to_vals[d] = w["text"]

        for d, start in from_vals.items():
            stop = to_vals.get(d)
            if stop is None:
                continue
            hours = _segment_hours(start, stop)
            segments_by_date.setdefault(d, []).append(ClockSegment(start, stop, hours))

    for d in segments_by_date:
        segments_by_date[d].sort(key=lambda seg: _hhmm_to_minutes(seg.start))

    return segments_by_date


def parse(pdf_path):
    import pdfplumber

    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[0]
        words = page.extract_words()
    return parse_from_words(words)


def parse_from_words(words):
    full_text = " ".join(w["text"] for w in words)

    name_m = re.search(r"Employee Name:\s*([A-Z][A-Z .'-]+?)\s+SSN:", full_text)
    year_m = re.search(r"Pay Period and Year:\s*(\d+)\s+(\d+)", full_text)
    # the date-range value sits on a different visual line than its "Pay
    # Period Date:" label and gets interleaved with other fields in reading
    # order, so match the M/D/YYYY - M/D/YYYY pattern directly instead of
    # anchoring to the label
    range_m = re.search(
        r"(\d{1,2})/(\d{1,2})/(\d{4})\s*-\s*(\d{1,2})/(\d{1,2})/(\d{4})",
        full_text,
    )
    total_m = re.search(r"Total Hours:\s*([\d.]+)", full_text)

    if not (name_m and year_m and range_m and total_m):
        raise ValueError("Could not find expected header fields in paystub PDF")

    employee_name = name_m.group(1).strip()
    pay_period_number = int(year_m.group(1))
    year = int(year_m.group(2))
    period_start = date(int(range_m.group(3)), int(range_m.group(1)), int(range_m.group(2)))
    period_end = date(int(range_m.group(6)), int(range_m.group(4)), int(range_m.group(5)))
    total_hours = float(total_m.group(1))

    # header date row: two weeks of "M/D" labels, all on the same `top`.
    # Other fields on the page (e.g. an "Official/Corrected: 1/1" stamp) can
    # also match the M/D pattern, so picking the first match in extraction
    # order isn't reliable — instead pick the `top` with the most matches
    # within tolerance, since the real header row has ~14 date labels and a
    # stray field has only one.
    date_header_words = [w for w in words if DATE_HDR_RE.match(w["text"])]
    if not date_header_words:
        raise ValueError("Could not find daily-hours date header row")
    candidate_tops = sorted({w["top"] for w in date_header_words})
    header_top = max(
        candidate_tops,
        key=lambda t: sum(1 for w in date_header_words if abs(w["top"] - t) < 2),
    )
    date_header_words = [w for w in date_header_words if abs(w["top"] - header_top) < 2]
    date_header_words.sort(key=lambda w: w["x0"])

    columns = []  # (date, x0)
    current_year = period_start.year
    prev_mo_day = None
    for w in date_header_words:
        m = DATE_HDR_RE.match(w["text"])
        mo, day = int(m.group(1)), int(m.group(2))
        # A pay period's date-header columns run forward in time (they're
        # sorted by x0 above, which matches chronological order); if the
        # month/day goes backwards (e.g. 12/31 -> 1/1) the header has
        # crossed into the next calendar year. Seeded from period_start's
        # real 4-digit year rather than the single `year` field, which
        # would otherwise mislabel every date after the rollover.
        if prev_mo_day is not None and (mo, day) < prev_mo_day:
            current_year += 1
        columns.append((date(current_year, mo, day), w["x0"]))
        prev_mo_day = (mo, day)

    grid_top = header_top

    # group all words by row (`top`, tolerance 2pt), keep rows below the
    # date header and above the "Clock Hours" section
    rows_by_top = {}
    for w in words:
        if w["top"] <= grid_top + 2:
            continue
        key = round(w["top"] / 2) * 2
        rows_by_top.setdefault(key, []).append(w)

    lines = []
    for top in sorted(rows_by_top):
        row = sorted(rows_by_top[top], key=lambda w: w["x0"])
        if len(row) < 3:
            continue
        if not OVERRIDE_RE.match(row[0]["text"]):
            continue
        override = row[0]["text"]
        jobcode = row[1]["text"]
        trans_code = row[2]["text"]
        rest = row[3:]

        hours_by_date = {}
        for w in rest:
            try:
                val = float(w["text"])
            except ValueError:
                continue
            d = _nearest_column(w["x0"], columns)
            if d is None:
                continue  # week/grand-total column, not a per-day value
            hours_by_date[d] = val

        lines.append(PaystubLine(override, jobcode, trans_code, hours_by_date))

    captured_total = sum(h for line in lines for h in line.hours_by_date.values())
    if abs(captured_total - total_hours) > 0.01:
        raise TotalHoursMismatchError(
            f"Parsed {captured_total:g} hours from the daily-hours grid, but the paystub's own "
            f"'Total Hours' field says {total_hours:g}. This usually means a row didn't extract "
            f"cleanly — treat this pay period as needing manual review rather than trusting the "
            f"conversion.",
            printed_total=total_hours, captured_total=captured_total,
        )

    clock_segments = _extract_clock_segments(words, columns)

    return Paystub(
        employee_name, year, pay_period_number, period_start, period_end,
        total_hours, lines, clock_segments,
    ), columns
