import io
from pathlib import Path

import pdfplumber
import pytest
from ap.documents import DocumentError, read_document, validate_pdf, verify_evidence
from reportlab.lib.pdfencrypt import StandardEncryption
from reportlab.pdfgen.canvas import Canvas


def pdf(pages=1, encrypted=False, size=(612, 792)):
    buf = io.BytesIO()
    c = Canvas(buf, pagesize=size, encrypt=StandardEncryption("secret") if encrypted else None)
    for _ in range(pages):
        c.drawString(30, 500, "Synthetic invoice")
        c.showPage()
    c.save()
    return buf.getvalue()


@pytest.mark.parametrize(
    "data",
    [b"", b"%PDF-corrupt", b"<script>alert(1)</script>", b"%PDF-" + b"x" * (10 * 1024 * 1024)],
)
def test_invalid_intake(data):
    with pytest.raises(DocumentError):
        validate_pdf(data)


def test_page_and_pixel_limit():
    assert validate_pdf(pdf(pages=10)) == 10
    with pytest.raises(DocumentError, match="pages"):
        validate_pdf(pdf(pages=11))
    with pytest.raises(DocumentError, match="rendering"):
        validate_pdf(pdf(size=(10000, 10000)))


def test_encryption():
    with pytest.raises(DocumentError):
        validate_pdf(pdf(encrypted=True))


def test_true_scans_have_no_text_layer():
    for filename in ["05-scan-conflict.pdf", "06-readable-scan.pdf", "17-heldout-scan.pdf"]:
        with pdfplumber.open(Path("fixtures/pdfs") / filename) as document:
            assert not any(page.extract_text() for page in document.pages)


def test_native_document_positions():
    pages, images = read_document(Path("fixtures/pdfs/01-clean.pdf").read_bytes())
    assert pages[0]["method"] == "native"
    assert "ALD-1201" in pages[0]["text"]
    assert pages[0]["words"][0]["x1"] > pages[0]["words"][0]["x0"]
    assert images[0].startswith(b"\x89PNG")


def test_omitted_unit_citation_recovered_from_real_sku_row():
    pages, _ = read_document(Path("fixtures/pdfs/07-multipage.pdf").read_bytes())
    data = {
        "lines": [{"sku": "MONITOR-27", "unit": "unit"}],
        "evidence": [
            {"field": "lines.0.sku", "page": 1, "quote": "MONITOR-27", "raw": "MONITOR-27"}
        ],
    }
    evidence = verify_evidence(data, pages)
    assert next(e for e in evidence if e["field"] == "lines.0.unit")["status"] == "observed"
    data["lines"][0]["unit"] = "box"
    assert not any(e["field"] == "lines.0.unit" for e in verify_evidence(data, pages))
