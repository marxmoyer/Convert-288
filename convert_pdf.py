"""CLI: convert a Paycheck8 Time & Attendance PDF into a filled OF-288 PDF.
Superseded by convert.py (Excel output) as the primary path — kept for
reference/rollback.

Usage: uv run convert_pdf.py <paystub.pdf> [-o output.pdf]
"""
import argparse
import json
import os

import of288_filler
import paycheck8_parser

TEMPLATE = "OF288-Fillable.pdf"
FIELD_MAP = "field_map.json"
PROFILE = "profile.json"
JOBCODE_RULES = "jobcode_rules.json"
TRANS_CODE_RULES = "trans_code_rules.json"
OUTPUT_DIR = "testoutput"


def _load_rules(path):
    data = json.load(open(path))
    data.pop("_comment", None)
    return data


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("paystub_pdf")
    ap.add_argument("-o", "--out", default=None)
    args = ap.parse_args()

    try:
        paystub, _ = paycheck8_parser.parse(args.paystub_pdf)
    except paycheck8_parser.TotalHoursMismatchError as e:
        raise SystemExit(f"Cannot convert: {e}")
    jobcode_rules = _load_rules(JOBCODE_RULES)
    trans_code_rules = _load_rules(TRANS_CODE_RULES)

    try:
        groups, reserved = of288_filler.build_groups(paystub, jobcode_rules, trans_code_rules)
    except of288_filler.UnrecognizedCodeError as e:
        raise SystemExit(f"Cannot convert: {e}")

    if args.out:
        out_path = args.out
    else:
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        base = f"OF288_PP{paystub.pay_period_number}_{paystub.year}"
        version = 1
        while True:
            candidate = os.path.join(OUTPUT_DIR, f"{base}_v{version}.pdf")
            if not os.path.exists(candidate):
                out_path = candidate
                break
            version += 1

    try:
        out_paths, used_columns, grand_total = of288_filler.fill(
            paystub, groups, reserved, TEMPLATE, FIELD_MAP, PROFILE, out_path
        )
    except of288_filler.ScheduleAllocationError as e:
        raise SystemExit(f"Cannot convert: {e}")

    print(f"Employee: {paystub.employee_name}  PP{paystub.pay_period_number} {paystub.year} "
          f"({paystub.period_start} - {paystub.period_end})")
    for name, g in groups.items():
        if not g["dates"]:
            continue  # every date this group had got excluded down to nothing
        total = sum(e["hours"] for e in g["dates"].values())
        print(f"  {name} (accounting code {g['meta']['accounting_code']}): {total:g} hrs across {len(g['dates'])} day(s)")
    print(f"Total hours (all columns): {grand_total:g}")
    if len(out_paths) > 1:
        print(f"Needed {len(out_paths)} sheets (more incidents/rows than one form's 4 columns hold):")
        for p in out_paths:
            print(f"  {p}")
    else:
        print(f"Wrote {out_paths[0]}")


if __name__ == "__main__":
    main()
