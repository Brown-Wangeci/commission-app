# Environment

The exact hardware and software this project's evidence was measured and
captured on. **There is no hosted deployment.** Every number in this chapter
-- the load test (NFR-01), the scoring latency measurement (NFR-02), the
screenshots, the logs, and every test run -- comes from this one developer
machine. README.md's "Known limitations" says the same thing: IR-09 (hosted
deployment) is not met. Where NFR-02 asks for figures "on the deployment
hardware", the deployment hardware and the measurement hardware are the same
machine, because no other exists.

## Hardware and deployment

| Item | Value | Purpose | Why this |
|---|---|---|---|
| CPU | 13th Gen Intel Core i7-1365U, 10 cores (12 logical) | Runs the app, the scoring service, PostgreSQL and the browser for screenshots, all at once during measurement | The only machine available to this project; a laptop-class mobile CPU, not server-class, which the NFR-01/NFR-02 reports state plainly |
| RAM | 16 GB | Headroom for Node, Python/XGBoost, PostgreSQL and a browser concurrently | As installed; not chosen for this project |
| OS | Windows 11 Pro, build 26200 | Host platform for every tool below | The developer's own machine |
| Deployment | None (no hosted instance) | N/A | IR-09 is not met; see README.md "Known limitations". All measurements below are against `npm start` / `next start` on this machine, not a server |
| Database host | Embedded PostgreSQL, 127.0.0.1:5433 | The app's own data store | `embedded-postgres` (see software table) starts a real PostgreSQL server locally with no separate installation, so the schema, triggers and constraints under test are the real ones, not a stand-in |
| Scoring service host | Uvicorn, 127.0.0.1:8000, single process | Serves the fraud model over HTTP exactly as the app calls it | Matches `src/serve/app.py`; one process, no load balancer, because there is no hosted deployment to put one in front of |
| Network | Loopback only (127.0.0.1) | Every measured call in this chapter | No measurement here includes real network latency, mobile data conditions, or a reverse proxy; NFR-01's own rationale (agents on mobile data) is therefore not reproduced by this measurement, which is a gap recorded in gaps.md |

## Software

| Component | Version | Purpose | Why this version |
|---|---|---|---|
| Node.js | 24.14.0 | Runtime for the Next.js app and every `tsx` script | Installed on the measurement machine; not pinned by this project beyond `package.json`'s own dependency versions |
| npm | 11.11.1 | Package manager for `app/` | Ships with the Node.js installation above |
| Next.js | 15.5.28 | The application framework (App Router, API routes) | Chosen at project start for integrated server-side routing, middleware and React 19 support |
| React / React DOM | 19.1.10 | UI rendering | Required by the chosen Next.js major version |
| TypeScript | 5.9.3 | Static typing across the application | Project-wide type safety; pinned in `app/package.json` |
| Prisma (client and CLI) | 6.19.3 | Database schema, migrations and typed queries | Hand-written migrations with self-checks are layered on top (see BUILD_LOG.md); chosen for migration-diff tooling and generated types |
| embedded-postgres | 17.6.0-beta.15 | Runs a real local PostgreSQL 17 server for development, tests and this chapter's measurements, with no separate install | Lets `npm run db:start` and the test suite run a genuine PostgreSQL instance (triggers, constraints, views) without requiring a system-wide installation |
| NextAuth | 4.24.15 | Session-based authentication and role routing | Established at project start; integrates with the Next.js middleware used for route protection |
| zod | 3.25.76 | Request and config validation | Used throughout the API layer for schema validation with typed output |
| bcryptjs | 2.4.3 | Password hashing (NFR-05) | Pure-JavaScript bcrypt, cost factor 10, avoiding a native build dependency |
| Vitest | 3.2.4 | The application test suite | Fast, native ESM/TypeScript support, used for all 383 app-level tests |
| viem | 2.57.7 | The blockchain client (reads and writes the audit-anchor contract) | Pinned at least two weeks old per this session's own versioning rule; typed, actively maintained Ethereum/EVM client |
| solc (solc-js) | 0.8.37 | Compiles `contracts/AuditAnchor.sol` | Pinned, reproducible compilation (a test recompiles and checks the committed artifact matches byte for byte); targets the `paris` EVM version so the bytecode runs on any current EVM chain |
| Anvil (Foundry) | 1.8.6 | Local EVM node for the blockchain anchoring evidence and the live chain test | Downloaded via the GitHub CLI and checked against Foundry's published SHA-256 before use; no funded Polygon Amoy wallet was available, so this stands in as the project's documented fallback (see `docs/chapter5/evidence/blockchain/README.md`) |
| @playwright/test | 1.64.1 | Browser automation for the Chapter 5 screenshots | Pinned at least two weeks old; drives a real Chromium browser against the real running app, rather than hand-captured images |
| Python | 3.14.3 | The ML pipeline, the scoring service, and this chapter's measurement scripts | As recorded at the top of `requirements.txt` since Phase 3 |
| numpy / pandas / scipy | 2.5.3 / 3.0.5 / 1.18.1 | Data generation and feature engineering | Per `requirements.txt` |
| scikit-learn | 1.9.1 | Metrics, isotonic calibration | Per `requirements.txt` |
| XGBoost | 3.4.1 | The fraud classifier itself | Per `requirements.txt` |
| imbalanced-learn | 0.14.2 | SMOTE / SMOTENC resampling (training split only, DR-04) | Per `requirements.txt` |
| SHAP | 0.52.0 | Feature attribution (FR-14) | Per `requirements.txt` |
| FastAPI / uvicorn / pydantic | 0.141.1 / 0.53.0 / 2.13.5 | The inference service (Phase 7) | Per `requirements.txt`; pydantic's `extra="forbid"` is what rejects malformed requests in IR-06's contract tests |
| pytest | 9.1.1 | The ML test suite | Per `requirements.txt`; used for all 150 committed Python tests |
| httpx | 0.28.1 | The scoring-latency measurement script's real HTTP client | Already a transitive dependency (FastAPI's recommended test client); reused here to make a genuine network round trip rather than an in-process call |

## What this environment does and does not establish

- **NFR-01 and NFR-02's numbers are specific to this one mobile-class laptop,
  under no real network latency, with one scoring-service process.** They
  are real measurements, not invented, but they are not evidence about
  production hardware, because none exists for this project.
- **The embedded PostgreSQL and single-process uvicorn are not how a
  production deployment would be configured** (no connection pooling, no
  multiple scoring workers, no reverse proxy). A hosted deployment could
  measure differently in either direction.
