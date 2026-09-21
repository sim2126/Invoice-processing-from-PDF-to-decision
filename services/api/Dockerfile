FROM python:3.12.11-slim-bookworm AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.11.6
WORKDIR /app
RUN useradd --create-home app && chown app:app /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen

# Samples are reproducibly generated from source; no PDFs or datasets are
# required in the repository or sent as part of the Docker build context.
FROM dependencies AS samples
COPY scripts/generate_fixtures.py scripts/generate_fixtures.py
RUN uv run --no-sync python scripts/generate_fixtures.py

FROM dependencies AS runtime
COPY --chown=app:app services services
COPY --chown=app:app scripts scripts
COPY --from=samples --chown=app:app /app/fixtures/pdfs fixtures/pdfs
COPY --chown=app:app tests tests
COPY --chown=app:app alembic.ini ./
ENV PYTHONPATH=/app/services/api
USER app
EXPOSE 8000
CMD ["uv", "run", "--no-sync", "uvicorn", "ap.main:app", "--host", "0.0.0.0", "--port", "8000"]
