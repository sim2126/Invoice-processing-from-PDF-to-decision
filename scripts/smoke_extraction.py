import json
import sys
import time
from pathlib import Path

sys.path.insert(0, "services/api")
from ap.documents import read_document, verify_evidence
from ap.extraction import extract

path = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures/pdfs/01-clean.pdf")
started = time.monotonic()
data, metadata = extract(path.read_bytes())
pages, _ = read_document(path.read_bytes())
evidence = verify_evidence(data, pages)
out = Path(".local")
out.mkdir(exist_ok=True)
(out / (path.stem + "-extraction.json")).write_text(
    json.dumps(
        {
            "extraction": data,
            "metadata": metadata,
            "evidence": evidence,
            "seconds": time.monotonic() - started,
        },
        indent=2,
    ),
    encoding="utf-8",
)
print(
    json.dumps(
        {
            "model": metadata["model"],
            "seconds": round(time.monotonic() - started, 2),
            "critical": {
                f: data[f]
                for f in ["vendor_name", "invoice_number", "invoice_date", "currency", "total"]
            },
            "unverified": [e["field"] for e in evidence if e["status"] == "unverified"],
        }
    )
)
