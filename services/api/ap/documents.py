import io
import re
from datetime import datetime

import pdfplumber
import pypdfium2 as pdfium
import pytesseract

from .config import settings
from .rules import decimal, identity


class DocumentError(ValueError):
    pass


def validate_pdf(data: bytes) -> int:
    if not data or len(data) > settings.max_bytes:
        raise DocumentError(f"Choose a non-empty PDF under {settings.max_bytes // 1048576} MB.")
    if not data.startswith(b"%PDF-"):
        raise DocumentError("The file is not a valid PDF. Export it as PDF and try again.")
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            if pdf.doc.encryption:
                raise DocumentError("Remove the PDF password/encryption before uploading.")
            count = len(pdf.pages)
            if not 1 <= count <= settings.max_pages:
                raise DocumentError(f"Upload one invoice with 1–{settings.max_pages} pages.")
            for page in pdf.pages:
                if (
                    page.width <= 0
                    or page.height <= 0
                    or page.width * page.height * 4 > settings.max_pixels
                ):
                    raise DocumentError(
                        "A PDF page exceeds the safe rendering size. Export standard-size pages."
                    )
            return count
    except DocumentError:
        raise
    except Exception as exc:
        raise DocumentError(
            "This PDF is corrupt or encrypted. Upload an unlocked, readable PDF."
        ) from exc


def read_document(data: bytes):
    validate_pdf(data)
    pages = []
    images = []
    with pdfplumber.open(io.BytesIO(data)) as native, pdfium.PdfDocument(data) as rendered:
        for index, page in enumerate(native.pages):
            bitmap = rendered[index].render(scale=2)
            image = bitmap.to_pil()
            output = io.BytesIO()
            image.save(output, format="PNG")
            images.append(output.getvalue())
            words = page.extract_words(x_tolerance=2, y_tolerance=3)
            method = "native"
            text = page.extract_text() or ""
            if len(text.strip()) < 30:
                method = "ocr"
                ocr = pytesseract.image_to_data(
                    image, config="--psm 3", output_type=pytesseract.Output.DICT, timeout=40
                )
                words = []
                for j, token in enumerate(ocr["text"]):
                    if token.strip():
                        words.append(
                            {
                                "text": token,
                                "x0": ocr["left"][j] / 2,
                                "top": ocr["top"][j] / 2,
                                "x1": (ocr["left"][j] + ocr["width"][j]) / 2,
                                "bottom": (ocr["top"][j] + ocr["height"][j]) / 2,
                                "confidence": float(ocr["conf"][j]),
                            }
                        )
                text = " ".join(w["text"] for w in words)
            pages.append(
                {
                    "page": index + 1,
                    "width": float(page.width),
                    "height": float(page.height),
                    "method": method,
                    "text": text,
                    "words": words,
                }
            )
            image.close()
            bitmap.close()
    return pages, images


def get_value(data, path):
    value = data
    for part in path.split("."):
        try:
            value = value[int(part)] if isinstance(value, list) else value[part]
        except (KeyError, ValueError, IndexError, TypeError):
            return None
    return value


def quote_hits(page, quote):
    """Match observed word sequences; ignore sentence-ending punctuation only."""

    def normalize(word):
        return identity(word).strip(".,:;")

    wanted = [normalize(w) for w in identity(quote).split()]
    words = page["words"]
    tokens = [normalize(w["text"]) for w in words]
    if not wanted:
        return []
    hits = []
    for i in range(len(tokens) - len(wanted) + 1):
        if tokens[i : i + len(wanted)] == wanted:
            group = words[i : i + len(wanted)]
            if page["method"] != "ocr" or min(w.get("confidence", 0) for w in group) >= 65:
                hits.append(group)
    return hits


def find_quote(page, quote):
    """Only a unique observed sequence receives a coordinate highlight."""
    hits = quote_hits(page, quote)
    if len(hits) != 1:
        return None
    group = hits[0]
    return [
        min(w["x0"] for w in group) / page["width"],
        min(w["top"] for w in group) / page["height"],
        max(w["x1"] for w in group) / page["width"],
        max(w["bottom"] for w in group) / page["height"],
    ]


def value_supported(value, quote, field):
    if value is None or not quote:
        return False
    if field.endswith("date"):
        # Locale-ambiguous numeric dates are deliberately not parsed.
        dates = re.findall(
            r"\d{4}-\d{2}-\d{2}|[A-Za-z]+ \d{1,2},? \d{4}|\d{1,2} [A-Za-z]+ \d{4}", quote
        )
        for raw in dates:
            for fmt in [
                "%Y-%m-%d",
                "%B %d, %Y",
                "%b %d, %Y",
                "%B %d %Y",
                "%b %d %Y",
                "%d %B %Y",
                "%d %b %Y",
            ]:
                try:
                    if datetime.strptime(raw, fmt).date().isoformat() == value:
                        return True
                except ValueError:
                    pass
        return False
    if field.split(".")[-1] in {
        "total",
        "subtotal",
        "tax",
        "tax_rate",
        "header_discount",
        "shipping",
        "quantity",
        "unit_price",
        "discount",
    }:
        target = decimal(value)
        return target is not None and any(
            decimal(n) == target for n in re.findall(r"-?\d[\d,]*(?:\.\d+)?", quote)
        )
    return identity(str(value)) in identity(quote)


def verify_evidence(data, pages, corrections=None):
    corrected = {c["field"]: c for c in corrections or []}
    results = []
    citations = {e["field"]: e for e in data.get("evidence", [])}
    # Recover an omitted unit citation only from a unique, observed SKU row.
    # The unit value remains unchanged, with no inferred quantity conversion.
    for index, line in enumerate(data.get("lines", [])):
        field = f"lines.{index}.unit"
        anchor = citations.get(f"lines.{index}.sku")
        if field in citations or not line.get("unit") or not line.get("sku") or not anchor:
            continue
        page = next((p for p in pages if p["page"] == anchor.get("page")), None)
        if (
            not page
            or not anchor.get("quote")
            or not value_supported(line["sku"], anchor["quote"], "sku")
        ):
            continue
        hits = quote_hits(page, line["sku"])
        if len(hits) != 1:
            continue
        row_top = hits[0][0]["top"]
        row = [w for w in page["words"] if abs(w["top"] - row_top) <= 3]
        matching = [w for w in row if identity(w["text"]) == identity(line["unit"])]
        if len(matching) != 1 or (
            page["method"] == "ocr" and matching[0].get("confidence", 0) < 65
        ):
            continue
        citations[field] = {
            "field": field,
            "page": page["page"],
            "quote": " ".join(w["text"] for w in row),
            "raw": matching[0]["text"],
        }
    for field, c in corrected.items():
        citations[field] = {
            "field": field,
            "page": c["page"],
            "quote": c["source_text"],
            "raw": c["source_text"],
        }
    for field, citation in citations.items():
        page_number = citation.get("page")
        page = next((p for p in pages if p["page"] == page_number), None)
        quote = citation.get("quote")
        bbox = find_quote(page, quote) if page and quote else None
        supported = value_supported(get_value(data, field), quote, field)
        observed = bool(page and quote and quote_hits(page, quote) and supported)
        reviewer = field in corrected and bool(page and quote and supported)
        results.append(
            {
                **citation,
                "bbox": bbox,
                "method": page["method"] if page else "unavailable",
                "status": "reviewer" if reviewer else "observed" if observed else "unverified",
                "label": "Confirmed by reviewer"
                if reviewer
                else "Found in document"
                if observed
                else "Needs verification",
                "support": "OCR and visual extraction agree; this is supporting evidence, not proof."
                if page and page["method"] == "ocr" and observed
                else None,
            }
        )
    return results
