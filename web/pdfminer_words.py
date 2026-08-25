"""Word/position extraction using pdfminer.six directly, standing in for
pdfplumber's page.extract_words() in the browser build (pdfplumber itself
can't install under Pyodide — its pypdfium2 dependency has no WASM wheel,
but pdfminer.six, the library pdfplumber's extraction is actually built on,
installs and runs fine).

Produces the same {"text", "x0", "top"} shape paycheck8_parser.parse_from_words
expects: x0 in native PDF left-to-right coordinates, top measured downward
from the top of the page (matching pdfplumber's convention), by grouping
pdfminer's character-level layout into words split at its own whitespace
annotations.
"""
from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTAnno, LTChar, LTContainer, LTTextLineHorizontal


def _walk_lines(el):
    if isinstance(el, LTTextLineHorizontal):
        yield el
    elif isinstance(el, LTContainer):
        for child in el:
            yield from _walk_lines(child)


def extract_words(pdf_path):
    page_layout = next(extract_pages(pdf_path, laparams=LAParams()))
    page_height = page_layout.height

    words = []
    for line in _walk_lines(page_layout):
        run = []
        for obj in line:
            if isinstance(obj, LTChar):
                if obj.get_text().isspace():
                    # A literal space glyph glued into the same line without
                    # an LTAnno boundary (seen e.g. between adjacent table
                    # cells like a trans code and the next column's value)
                    # is a word break too — otherwise they merge into one
                    # token (e.g. "21 66"), corrupting column alignment
                    # downstream in paycheck8_parser.
                    if run:
                        words.append(_word_from_run(run, page_height))
                        run = []
                    continue
                run.append(obj)
                continue
            # LTAnno marks whitespace pdfminer inserted between words/lines
            if isinstance(obj, LTAnno) and run:
                words.append(_word_from_run(run, page_height))
                run = []
        if run:
            words.append(_word_from_run(run, page_height))

    return words


def _word_from_run(run, page_height):
    text = "".join(c.get_text() for c in run)
    x0 = min(c.x0 for c in run)
    y1 = max(c.y1 for c in run)
    return {"text": text, "x0": x0, "top": page_height - y1}
