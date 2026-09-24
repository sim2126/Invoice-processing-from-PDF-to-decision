# AP Review Desk

A PDF-to-decision accounts-payable workspace with real AI extraction, retrieval from company references, cited review assistance, automatic purchase-order checks, and an auditable review loop.

The repository contains application/test source, configuration, dependency locks, and this README. PDFs, datasets, screenshots, reports, credentials, uploaded documents, and internal build materials are excluded. Synthetic demonstration PDFs are generated from Python source during the Docker build; no PDF files need to be downloaded from this repository.

## Run with Docker

Requirements: Docker Desktop using Linux containers, approximately 4 GB available memory, and an OpenAI API key with access to the selected PDF-capable model.

1. Clone the source and enter the folder:

   ```powershell
   git clone https://github.com/sim2126/Invoice-processing-from-PDF-to-decision.git
   cd Invoice-processing-from-PDF-to-decision
   ```

2. For a new checkout, create your private environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

   Preserve an existing configured `.env`. Set `OPENAI_API_KEY` and `INVOICE_MODEL` in that file. The evaluated model is `gpt-4.1-mini-2025-04-14`. Do not put credentials in frontend variables or commit `.env`.

3. Build and start the application:

   ```powershell
   docker compose up --build -d --wait
   ```

4. Open **http://localhost:3000**. API health: http://localhost:8005/health. Readiness: http://localhost:8005/ready.

The services are Next.js, FastAPI, Celery, a durable dispatcher, PostgreSQL, Redis, and private S3-compatible storage. All local ports bind to loopback. Ports: web 3000, API 8005, PostgreSQL 5434, Redis 6381, storage 9002/9003. Docker volumes preserve database and document state.

```powershell
# Inspect service state and operational logs:
docker compose ps
docker compose logs --tail 100 api worker dispatcher
# Stop without deleting stored data:
docker compose down
```

Adding `-v` to `down` deletes this project's persistent volumes. The database/storage passwords in the local Compose example are development-only; use generated private credentials when hosting.

## Try the workflow

Open the [hosted demo](https://inv-pdf.up.railway.app). Choose **Load example invoices** to populate the queue with four real PDFs, or open **Documents → Sample invoices** to run them individually. Each browser workspace starts with fictional suppliers, purchase orders and prior accepted balances. Loading examples uses the real processing pipeline and is idempotent for the same source files.

Use **Invoices** for the full queue and **To-do** for unresolved reviews, blocked invoices and failed runs. Search, status filters and sorting work in both views. **Suppliers** shows invoice totals, exceptions, purchase orders and accepted commitments from workspace records; these figures are not payment balances.

Each of the five sample rows has an **eye icon** to preview the actual PDF, zoom controls, a download icon, and **Run** to submit it. Previewing does not create an invoice or use the extraction model. **Download demo pack (5 PDFs)** provides all five originals plus a short testing guide in a ZIP, useful for sharing or testing the normal upload path.

Upload a PDF or use the five scenario buttons, which submit real generated PDFs through normal intake:

1. **A clean match:** $1,200 against PO-1038; expected approval.
2. **Same invoice, new PDF:** run the clean case first; alternate rendering is blocked as a duplicate.
3. **A PO at its limit:** $4,500 against $4,000 remaining; review with a $500 shortfall.
4. **Two possible orders:** initially requires review because both orders are plausible. Open **Documents → Company references → Add example reference**, then return to the invoice and select **Ask AI to review**. AI retrieves the explicit assignment of MER-2081 / MERIDIAN-002 to PO-1088; the server validates that evidence and reruns every check before approval. Alternatively confirm the PO in **Review & resolve**. Both paths preserve history.
5. **The numbers disagree:** a real scan contains conflicting printed totals; keep it on hold and request a corrected invoice.

For five additional invoice-to-clarification workflows, open **Documents → Follow-up examples**. Each example has a synthetic invoice and a separate supporting PDF, both with eye previews and downloads:

| Invoice | Example | Amount | After adding the supporting document |
| --- | --- | --- | --- |
| MER-2201 | Brand project assignment | $800 | Match PO-1088; approve if all checks pass |
| MER-2202 | Product buyer confirmation | $1,200 | Match PO-1091; approve if all checks pass |
| ALD-2203 | Office delivery allocation | $600 | Match PO-1038; approve if all checks pass |
| FW-2204 | Equipment receipt and assignment | $600 | Match PO-1103; approve if all checks pass |
| ALD-2205 | Procurement confirmation with insufficient budget | $4,500 | Match PO-1042; remain in review with at least a $500 shortfall |

Run an invoice first, inspect the AI question and prepared follow-up draft, then add that example's supporting document. Open the invoice and choose **Ask AI to review**. This creates a new decision with cited evidence while retaining the earlier review. These documents simulate the clarification a buyer or supplier would provide; nothing is emailed automatically. The equipment receipt supplies a PO assignment, not a separate automated goods-receipt validation. Approval still uses two-way matching and current balances.

The follow-up pack downloads all ten PDFs and a walkthrough in one ZIP. These additional cases are separate from **Load example invoices** and the original five sample cases. Previewing and downloading remain read-only; running or adding a document uses the normal invoice/reference upload routes. The original 20-document evaluation corpus is unchanged.

**Settings → General → Start a fresh workspace** creates a separate workspace with the original seed balances. Extraction is probabilistic, so uncertain or unsupported evidence may require review. Failed extraction is an execution failure; unavailable AI assistance is explicitly marked and the exact policy checks remain available.

Approval records an accepted invoice commitment for the next AP step. It does not execute payment or confirm receipt of goods. Scope: fictional companies/suppliers, USD, one invoice/PO per PDF, two-way matching, maximum 10 MB/10 pages by default. Reviewers and AI cannot override hard blockers or increase PO ceilings.

## AI and workspace features

- **Grounded assistance:** the existing model extracts invoice facts, then a bounded structured-output call explains the checks, cites retrieved sources and drafts a follow-up. Relevant references are retrieved with lexical matching from this workspace's PDFs. This is retrieval-augmented generation over a small scoped corpus, not a vector database or an unrestricted agent. Quotes and source IDs are verified; this does not guarantee that every generated interpretation is correct.
- **Automatic missing-PO matching:** requires an explicit reference containing the invoice number, supplier identifier and a unique active PO. Conflicting references, archived sources, printed PO references and human selections prevent automatic replacement. Current quantities, amounts, duplicates and balances are rechecked under the final database lock. Financial arithmetic uses Decimal, not model arithmetic.
- **Company references:** upload, preview, download and archive PDFs. At most 20 active PDFs; 30 reference uploads per workspace/day and 300 globally. Archived files leave future retrieval; recorded citation quotes remain in decision history.
- **Named profiles and team access:** edit your name/contact email and company details. Owners create/revoke single-use invitation links and remove members; reviewers process invoices; viewers read only. No invitation email is sent. Links are bearer credentials, emails are unverified, and access expires with the evaluation workspace (24 hours by default). This is not an enterprise identity/login system.
- **Connections:** Gmail, Outlook, QuickBooks Online, Xero and NetSuite are marked **Coming soon**. No synchronization, email sending or ERP posting is implemented. AI follow-ups are drafts to review and copy.

Keep company identity separate from the user's profile. New workspaces start with Prabhakar Kumar as the editable owner name. All workspace records and reference retrieval are isolated by workspace.

## Development

Python 3.12+ with `uv`; Node.js 22.20+ with `pnpm@10.17.1`.

```powershell
uv sync --frozen
# Generate optional local test PDFs and their evaluation manifest; all remain ignored:
uv run python scripts/generate_fixtures.py
# Generate the local OpenAPI artifact:
uv run python scripts/export_contracts.py
cd apps/web
pnpm install --frozen-lockfile
pnpm contracts
pnpm typecheck
pnpm lint
pnpm build
```

From the root, `docker compose -f compose.yaml -f compose.dev.yaml up -d` mounts backend source for development. Run the fixture generator first when using this overlay; its local fixture mount replaces the samples generated into the image. Plain `docker compose up` uses the built images.

## Verify

From the repository root, after the Docker stack is healthy:

```powershell
# Real PostgreSQL tests in a separate apdesk_test database; never SQLite:
powershell -NoProfile -File scripts/test-backend.ps1
uv run ruff check services/api scripts tests
uv run ruff format --check services/api scripts tests
# Inspect exactly what Git would publish:
uv run python scripts/check_publish.py
```

For browser tests, from `apps/web`:

```powershell
pnpm exec playwright install chromium
$env:RUN_LIVE_E2E='1'
pnpm test:e2e
```

The live browser flow consumes model tokens (normally one extraction call plus one assistance call per new invoice). It covers all five scenarios, reference-backed automatic PO resolution, team permissions, document previews, review resolution, refresh, interrupted streaming/polling, keyboard controls, accessibility, and mobile layouts. Test screenshots and reports stay in ignored local folders.

Optional live evaluation, from the root:

```powershell
uv run python scripts/generate_fixtures.py
uv run python scripts/evaluate.py --set release
```

The generator produces 20 synthetic PDFs across five layouts. Expected labels are used only by the offline evaluation harness; live extraction never reads them. The report is created locally under ignored `docs/`. A nonzero evaluation exit indicates an expected outcome differed; inspect that report rather than suppressing the failure. Automated provider doubles exist only in isolated tests.

## Host on Railway

A GitHub repository stores source; running this application also requires its backend, worker, database, queue and document storage.

1. Create a Railway account and an empty project. Set a hosting budget. An authenticated CLI or project token can automate the following configuration; keep tokens in a local ignored file or the credential store, never in GitHub or chat.
2. Add PostgreSQL, Redis and a private S3-compatible bucket. Retain database/storage data across deployments. A Railway storage bucket can replace the local MinIO service once its S3 settings are configured and verified.
3. Create four application services from this repository:

   | Service | Root/build configuration | Start command |
   | --- | --- | --- |
   | web | Root `apps/web`, Dockerfile `Dockerfile` | Image default: `node server.js` |
   | api | Repository root, Dockerfile `services/api/Dockerfile` | `uv run --no-sync uvicorn ap.main:app --host 0.0.0.0 --port 8000` |
   | worker | Repository root, same backend Dockerfile | `uv run --no-sync celery -A ap.worker:celery worker --loglevel=info --concurrency=2` |
   | dispatcher | Repository root, same backend Dockerfile | `uv run --no-sync python -m ap.dispatcher` |

4. Set backend service variables: `DATABASE_URL` with the `postgresql+psycopg://` scheme, `REDIS_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`, `S3_ADDRESSING_STYLE`, `OPENAI_API_KEY`, `INVOICE_MODEL`, `APP_ORIGIN=https://<public-web-host>`, and `COOKIE_SECURE=true`. Use the bucket's actual S3 name, endpoint and region from its Credentials tab. New Railway buckets use `S3_ADDRESSING_STYLE=virtual`; local MinIO uses `path`. Share backend values with API/worker/dispatcher only. Set API `PORT=8000`. Configure web with `API_INTERNAL_URL=http://<api-private-host>:8000` and `PORT=3000`; target its public domain at port 3000.
5. Run `uv run --no-sync alembic upgrade head` as the API pre-deploy command. Confirm the private bucket exists and is reachable (`uv run --no-sync python scripts/init_storage.py`). Start the API, then worker/dispatcher/web. Configure API health checking at `/health` on port 8000 and verify `/ready` before sharing.
6. Generate a public HTTPS domain for **web only**. Keep the API, database, Redis and document storage private. Set `APP_ORIGIN` to the exact public web origin, then redeploy backend services.
7. To use `inv-pdf.com`, first own the domain and have DNS access. Add it to the web service's custom domains and copy Railway's exact DNS/verification records into the DNS provider. For an apex domain, the DNS provider must support the relevant alias/flattening configuration. Wait for domain verification and HTTPS issuance. Set `APP_ORIGIN=https://inv-pdf.com` before final testing. The repository does not claim this domain is registered or deployed.
8. On the actual public URL, test fresh-session upload, source viewing, streaming, duplicate blocking, the PO review loop, JSON export, and denial of another session's data. Restart services without deleting storage and verify saved history. Use the verified URL for the demo submission.

Defaults limit each session to 40 uploads and 30 model calls/day, and the deployment to 300 uploads, 100 model calls and 200 new sessions/day. Adjust deliberately for the review period. Keep services available during the interview. No public hosting is implied merely by pushing this repository.

Official references: [Railway Docker Compose mapping](https://docs.railway.com/guides/docker-compose), [Railway CLI](https://docs.railway.com/cli), [storage buckets](https://docs.railway.com/storage-buckets), [custom domains](https://docs.railway.com/networking/domains/working-with-domains).

## Source layout

- `apps/web`: Next.js UI, API/streaming proxy, browser tests and generated TypeScript contracts.
- `services/api/ap`: document parsing/OCR, structured extraction, Decimal rules, transactional decisions, API, worker and dispatcher.
- `services/api/migrations`: database schema, immutable history and commitment guards.
- `scripts`: startup, fixture generation, validation, contract generation and code-publication checks.
- `tests`: rules, document handling, provider boundaries and PostgreSQL integration tests.

`.gitignore` and `scripts/check_publish.py` enforce the code-only publishing boundary. Generated inputs and reports are intentionally absent from GitHub.
