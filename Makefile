export PATH := $(HOME)/.local/node/bin:$(HOME)/.local/bin:$(PATH)
PYTHON ?= .venv/bin/python
PIP ?= .venv/bin/pip
UVICORN ?= .venv/bin/uvicorn
PYTEST ?= .venv/bin/pytest

.PHONY: venv install test test-frontend test-e2e check prove-wise0855 precache refresh-data refresh validate backend frontend dev build

venv:
	uv venv --python 3.12 .venv
	$(PIP) install -r backend/requirements.txt

install: venv
	cd frontend && npm install

test:
	cd backend && ../$(PYTEST) -q

test-frontend:
	cd frontend && npm test

test-e2e:
	cd frontend && npm run test:e2e

# Full local gate: backend + frontend unit + production build + Playwright e2e.
check: test test-frontend build test-e2e
	@echo "make check OK"

prove-wise0855:
	$(PYTHON) pipeline/prove_wise0855.py

precache:
	$(PYTHON) pipeline/precache_targets.py
	$(PYTHON) pipeline/run_validation.py
	$(PYTHON) pipeline/inject_movers.py

# Safe refresh: stage → validate → swap. Never wipes demo-data on failure.
refresh-data:
	$(PYTHON) pipeline/refresh_data.py

# Alias used in docs / challenge checklist.
refresh: refresh-data
	@echo "make refresh: cache refresh finished (see pipeline/refresh_data.py log for diffs)."

validate:
	$(PYTHON) pipeline/run_validation.py

backend:
	$(UVICORN) app.main:app --app-dir backend --reload --port 8000

frontend:
	cd frontend && npm run dev -- --host 127.0.0.1 --port 5173

build:
	cd frontend && npm run build

dev:
	@echo "Terminal A: make backend"
	@echo "Terminal B: make frontend"
	@echo "Then open http://127.0.0.1:5173"
