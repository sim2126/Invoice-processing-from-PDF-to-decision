# Tickmark

Tickmark turns a supplier's PDF invoice into a decision an accounts-payable team can act on, and shows its work. It reads the document (text layer or OCR), extracts every field with a citation to the page, matches the supplier and purchase order, and runs explicit policy checks: price tolerance, totals, duplicates, and cumulative PO budget and quantity. It then decides **Approved**, **Needs review** or **Blocked**, and each step appears as it runs. People handle the exceptions: they confirm an order (or ask the AI to find the answer in company documents), ask procurement or the supplier for what is missing, or reject.

Hosted app: https://inv-pdf.up.railway.app. Every visitor gets a private workspace.

## What a new workspace contains

- **Juniper Labs**, a fictional company, with 8 suppliers (one inactive) and 10 purchase orders (one closed).
- **26 processed invoices from Sep 22 to Oct 26.** They are imported history: generated PDFs with known field values, decided by the same rules engine and with no model calls. They include clean approvals, a closed PO, an inactive supplier, a duplicate in a new layout, a missing invoice number (on hold, waiting on the supplier), a PO over budget, a price above tolerance, and two missing POs that a reviewer resolved.
- **An inbox of 6 invoices and 1 reply that arrived this morning.** Checking an inbox invoice runs the full live pipeline: OCR when needed, model extraction with citations, the checks, and an AI explanation.

| Inbox item | Edge case | Expected result | What to do next |
| --- | --- | --- | --- |
| CF-7815 · Coastline Freight | Clean match | Approved; $900 reserved on PO-1120 | — |
| ALD-1202 · Alder Office Supply | Price 80¢ above the PO (within 1% and $1) | Approved, with the variance noted | — |
| ALD-1201 (resent) · Alder | Same invoice, different PDF layout | Blocked as a duplicate of the Oct 26 invoice | Open the original |
| ALD-1450 · Alder | Split PO: $4,500 against $4,000 left after two earlier invoices | Needs review: $500 and 5 cases over | Ask procurement (puts it on hold) |
| MER-2081 · Meridian Creative | No PO printed; two open orders fit | Needs review; the PO is never guessed | Save Maya Patel's reply from the inbox, then **Ask AI to check company documents**. The AI cites the assignment, PO-1088 is matched, every check reruns, and the invoice is approved |
| FW-3099 · Fieldwork (scan) | Scanned image; lines add to $900 but $990 is printed | Needs review (totals) | Request a corrected invoice, or reject |

## How a decision is made

1. **Received**, then **Read the document**: the text layer is used where present; otherwise the page is OCR'd at 300 dpi. Original files and page images are kept privately.
2. **Extract the fields**: a structured-output call to the model with no tools. The PDF is treated as untrusted data, and every value must cite text that is actually on the page. Uncited values can never support an approval.
3. **Supplier is approved**, **Purchase order**, **Lines match the order**: exact supplier ID or an approved alias; an open PO from the same supplier; SKU and unit must match. The unit price may exceed the PO price only within both 1% and $1.00.
4. **Totals add up**, **Not a duplicate**, **Within PO budget**: Decimal arithmetic (±$0.01). Duplicates are matched on business identity (supplier, number, date, total), not just the file. Budget and quantity are cumulative across every invoice billed to the PO, rechecked under a database lock when the decision is recorded.
5. **Decision**: Blocked outranks review, and approval needs every check to pass. Approval reserves the amount on the PO for payment prep; it does not pay anyone.
6. **Explanation**: the model explains the checks in plain language, cites the sources it used, and drafts the follow-up message. It cannot approve anything or change a figure.

Nobody can approve past a failed check. A person can confirm an order with a reason (every check reruns), put an invoice on hold while waiting on procurement or the supplier, or reject it. Every action is kept in the invoice's history.

## Run locally with Docker

Requirements: Docker Desktop (Linux containers), about 4 GB of memory, and an OpenAI API key.

```powershell
git clone https://github.com/sim2126/Invoice-processing-from-PDF-to-decision.git
cd Invoice-processing-from-PDF-to-decision
Copy-Item .env.example .env   # then set OPENAI_API_KEY and INVOICE_MODEL
docker compose up --build -d --wait
```

Open http://localhost:3000. API health: http://localhost:8005/health and readiness: http://localhost:8005/ready.

Settings in `.env`:
- `INVOICE_MODEL`: the evaluated model is `gpt-4.1-mini-2025-04-14`.
- `INVOICE_REASONING_EFFORT`: optional, for reasoning models only.
- `SEED_HISTORY`: default `true`; set it to `false` for empty workspaces.

Services: Next.js web, FastAPI, Celery worker, a durable dispatcher, PostgreSQL, Redis and private S3-compatible storage (MinIO locally). All ports bind to loopback: web 3000, API 8005, PostgreSQL 5434, Redis 6381, storage 9002/9003. `docker compose down` keeps your data; adding `-v` deletes it.

## Measured evaluation

The 20-PDF corpus (five layouts, three image-only scans, one multi-page invoice, five held-out files) was run through the real upload path on Oct 27, 2026:

| Model | Matched expected outcome | False automatic approvals | Median time |
| --- | --- | --- | --- |
| gpt-4.1-mini-2025-04-14 (configured) | 19/20 | 0 | 14.4 s |
| gpt-5.4-mini-2026-03-17, low reasoning | 18/20 | 0 | 14.0 s |

The one miss with gpt-4.1-mini is the prompt-injection PDF, held for review because a line description could not be verified on the page. It failed safe. gpt-5.4-mini held both readable scans for the same reason. To reproduce: `uv run python scripts/generate_fixtures.py`, then `uv run python scripts/evaluate.py --set release` with the stack running and `SEED_HISTORY=false`. These are measurements on synthetic documents, not production accuracy claims.

## Scope

USD only. One invoice and one PO per PDF; at most 10 pages and 10 MB. Two-way matching, because there is no goods-receipt data. The inbox is a set of synthetic arrivals and no mailbox is connected. History is imported synthetic data; only inbox and uploaded invoices use the model. Workspace access is a private 24-hour session, not enterprise identity. Approval records a commitment for payment prep and never moves money.

## Development

Python 3.12+ with `uv`; Node.js 22.20+ with `pnpm@10.17.1`.

```powershell
uv sync --frozen
uv run python scripts/generate_fixtures.py      # evaluation corpus, history and inbox fixtures (ignored by Git)
uv run python scripts/export_contracts.py       # OpenAPI contract for the web types
cd apps/web
pnpm install --frozen-lockfile
pnpm contracts
pnpm typecheck
pnpm lint
pnpm build
```

`docker compose -f compose.yaml -f compose.dev.yaml up -d` mounts the backend source and the local `fixtures/` folder. Run the fixture generator first.

## Verify

From the repository root, with the Docker stack healthy:

```powershell
powershell -NoProfile -File scripts/test-backend.ps1   # real PostgreSQL, isolated apdesk_test database
uv run ruff check services/api scripts tests
uv run ruff format --check services/api scripts tests
uv run python scripts/check_publish.py                 # exactly what Git would publish
```

Browser tests, from `apps/web`:

```powershell
pnpm exec playwright install chromium
pnpm exec playwright test e2e/tickmark.spec.ts          # pages, phone width, accessibility (no model calls)
$env:RUN_LIVE_E2E='1'; pnpm exec playwright test e2e/tickmark.spec.ts   # adds the five live inbox flows
```

The live flows make real model calls: usually one extraction call and one assistance call per invoice checked.

## Host on Railway

The project runs as four services built from this repository, plus PostgreSQL, Redis and a private storage bucket.

| Service | Build | Start command |
| --- | --- | --- |
| web | Root `apps/web`, `Dockerfile` | image default (`node server.js`) |
| api | Repository root, `services/api/Dockerfile` | `uv run --no-sync uvicorn ap.main:app --host 0.0.0.0 --port 8000` |
| worker | same backend image | `uv run --no-sync celery -A ap.worker:celery worker --loglevel=info --concurrency=2` |
| dispatcher | same backend image | `uv run --no-sync python -m ap.dispatcher` |

Backend variables:
- `DATABASE_URL` with the `postgresql+psycopg://` scheme, plus `REDIS_URL`.
- Storage: `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION` and `S3_ADDRESSING_STYLE` (`virtual` for Railway buckets). Set them as references to the bucket, e.g. `${{documents.ACCESS_KEY_ID}}`, so they always match it.
- `OPENAI_API_KEY`, `INVOICE_MODEL`, `APP_ORIGIN=https://<public-web-host>`, `COOKIE_SECURE=true`.

Web needs `API_INTERNAL_URL=http://<api-private-host>:8000`. Use `uv run --no-sync alembic upgrade head` as the API pre-deploy command, put the health check on `/health`, and confirm `/ready` before sharing. Only the web service gets a public domain.

References resolve when a service deploys. If the bucket's credentials change, redeploy the api, worker and dispatcher; `/ready` reports a storage 403 until you do. Default quotas: 40 uploads and 30 model calls per session per day, and 300 uploads, 100 model calls and 200 new sessions per day overall. Raise them deliberately for a review period.

## Source layout

- `apps/web`: the Next.js UI, the API/streaming proxy, browser tests and generated TypeScript contracts.
- `services/api/ap`:
  - `documents`: parsing, OCR and evidence
  - `extraction`: the model call
  - `rules`: Decimal policy
  - `checks`: check groups and reasons
  - `pipeline`: runs, events and transactional decisions
  - `intake`: upload and inbox submission
  - `history`: imported history
  - `inbox`
  - `assistant`: grounded explanations and PO matching
  - plus the API, worker and dispatcher
- `services/api/migrations`: schema, immutable history, commitment guards and workflow states.
- `scripts`: fixture generation, evaluation, contract export, smoke checks and the publication guard.
- `tests`: rules, documents, workflow, history and PostgreSQL integration tests.

`.gitignore` and `scripts/check_publish.py` enforce a code-only repository. Generated PDFs, datasets and reports never go to GitHub.
