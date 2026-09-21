import json
import sys
from pathlib import Path

sys.path.insert(0, "services/api")
from ap.main import app

output = Path("docs/openapi.json")
output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps(app.openapi(), indent=2), encoding="utf-8")
print("Exported FastAPI OpenAPI contract")
