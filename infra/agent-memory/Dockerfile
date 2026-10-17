# syntax=docker/dockerfile:1
# agent-memory server, built from a pinned commit (the library is not on PyPI).
# Dependencies are the exact versions in the project's uv.lock, installed with --require-hashes,
# so every wheel is checked against PyPI's sha256 whichever index serves it (PIP_INDEX_URL).
FROM python:3.11-slim
ARG AGENT_MEMORY_REF=5d5daaef4e1d6eb550dc015bbb963a814002eec0
ARG PIP_INDEX_URL=https://pypi.org/simple
COPY --from=ghcr.io/astral-sh/uv@sha256:606e70c71c852d03f611b1e56a195d08648507018a7057fab82c4974c4eae105 /uv /usr/local/bin/uv
ADD https://github.com/mongodb-partners/agent-memory.git#${AGENT_MEMORY_REF} /app
WORKDIR /app
RUN uv export --frozen --no-dev --no-emit-project --extra openai --extra rest -o /tmp/requirements.txt \
 && pip install --no-cache-dir --require-hashes --index-url "$PIP_INDEX_URL" -r /tmp/requirements.txt \
 && useradd --create-home --uid 10001 appuser
ENV PYTHONPATH=/app
USER appuser
EXPOSE 8000
CMD ["python", "-m", "agent_memory"]
