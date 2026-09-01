# Digital Hub — Technical Knowledge & Collaboration Platform

A serverless AWS application that gives the Digital Hub Programme Centre a single
discovery-and-collaboration layer over its fragmented technical knowledge:
**Problems, Initiatives, Solutions, Findings, Assets and SME Profiles**. It lets
teams search across everything the programme knows, surfaces overlapping
initiatives automatically, routes questions to the right experts, and gives
leadership a portfolio view.

Pushes to `main` trigger the platform's build pipeline, which runs `./deploy.sh`.

---

## What it does (mapped to the requirements)

| Capability | How it works | Requirements |
|---|---|---|
| Entity CRUD + knowledge graph | `fn-crud` serves all six entity types, writes relationship edges, and indexes each record for search | 1, 8 |
| Manual contribution + review | `fn-review-publish`: `POST /submissions` → pending in the review queue → reviewer `approve`/`reject`; approval embeds + indexes | 2 |
| Automated ingestion | `fn-ingestion` validates Jira (shared-secret) and GitHub (HMAC) webhooks, buffers to SQS, then normalises + indexes without review; Confluence/Jira polled on a schedule | 3 |
| Semantic + hybrid search | `fn-search`: Bedrock embeds the query → S3 Vectors similarity search per entity type → metadata filter → optional LLM re-rank | 4 |
| Overlap detection + smart nudges | `initiative-registered` event → Step Functions (`fn-overlap-embed` → `fn-overlap-classify` → SNS) classifies pairs Strong/Partial/Novel and notifies | 5 |
| 1-click collaboration | `POST /nudges/{id}/collaborate` links initiatives or logs SME office-hours | 6 |
| SME guidance routing | `fn-sme-router` matches 1–3 SMEs (expertise similarity 70% + availability 30%) and publishes to SNS → Slack/Teams | 7 |
| Portfolio dashboard | `fn-dashboard` aggregates weekly (themes, overlap hotspots, reuse rate, gaps) to DynamoDB + S3 | 8 |
| AuthN/Z | Cognito user pool + hosted groups (Lead/SME/Reviewer/Portfolio/Mgmt/Ops); API Gateway Cognito authorizer + per-route group checks | 9 |
| Observability | Per-function CloudWatch log groups (2-yr retention), X-Ray tracing, SQS DLQs + depth alarms → ops SNS topic | 10 |

Notifications (`fn-notifier`) fan out from the overlap and SME-routing SNS topics
to Slack/Teams incoming webhooks.

## Architecture

```
Browser (SPA on CloudFront)
   │  Cognito (USER_PASSWORD_AUTH) → JWT
   ▼
API Gateway (Cognito authorizer)                Webhook API (secret/HMAC)
   │                                                   │
   ▼                                                   ▼
Lambda (crud/search/review/guidance/dashboard)   Lambda (ingestion) ── SQS ─┐
   │            │            │                                              │
   ▼            ▼            ▼                                              ▼
DynamoDB     S3 Vectors    Bedrock  ◄── embeddings / classification / re-rank
(11 tables)  (1 bucket,     (Cohere embed + Claude Haiku)
             6 indexes)

EventBridge (initiative-registered) → Step Functions (overlap detection) → SNS → notifier → Slack/Teams
EventBridge (schedules) → ingestion poll / weekly dashboard
```

- **Compute:** Lambda (Node.js 22) + Step Functions. No servers, no VPC/NAT (uses the account defaults only where required; this app is fully serverless).
- **Data:** DynamoDB (six entity tables + relationships, audit-log, review-queue, analytics-snapshot, overlap-results). Semantic vectors in **Amazon S3 Vectors** (one index per entity type inside a single vector bucket).
- **AI:** Amazon Bedrock — `cohere.embed-multilingual-v3` (1024-dim embeddings) and `global.anthropic.claude-haiku-4-5-...` (classification / re-rank).
- **Edge:** CloudFront serves the SPA over TLS; the SPA calls API Gateway directly (CORS enabled). `app_url` is the CloudFront domain.

## Repository layout

```
template.yaml         SAM template — all infrastructure (single source of truth)
deploy.sh / destroy.sh Fixed entry points the build system runs
layer/                Shared AWS SDK v3 dependencies (built into a Lambda layer)
src/
  lib/                Thin AWS wrappers + domain helpers (the shared contract)
    __mocks__/        Jest manual mocks (so unit tests never load the SDK)
  handlers/           One file per Lambda handler
frontend/             Vanilla-JS SPA (CAPE DLS Light design); config.js generated at deploy
test/                 Jest unit tests (behaviour, mocked wrappers)
docs/ spec/ design/   Reference material from the BRD Architect phase
```

## Deploy / operate

The platform runs these; you can run them locally with AWS credentials for
`ap-southeast-1`.

```bash
./deploy.sh     # builds + deploys; writes outputs.json (incl. app_url)
./destroy.sh    # tears everything down
```

`deploy.sh` is idempotent and, in order: ensures the artifacts bucket exists;
creates the S3 Vectors bucket + one index per entity (via the `s3vectors` CLI —
these are not CloudFormation resources, like ECR); `npm install` then `sam build`;
`sam deploy` into the `app-193a359c-027ffd1c-portal` stack; ensures a fixed set
of platform users exist in the Cognito user pool and belong to every persona
group (via `admin-create-user` / `admin-add-user-to-group` — also not
CloudFormation resources); then generates `frontend/config.js`, uploads the
SPA, invalidates CloudFront, and writes `outputs.json`.

### After the first deploy
Third-party integrations ship with placeholder secrets. To enable them, set the
real values (never commit them) in AWS Secrets Manager:

- `app-193a359c-027ffd1c-secret-jira` → `{ "apiToken", "webhookSecret", "baseUrl" }`
- `app-193a359c-027ffd1c-secret-github` → `{ "token", "webhookSecret" }`
- `app-193a359c-027ffd1c-secret-confluence` → `{ "apiToken", "baseUrl" }`
- `app-193a359c-027ffd1c-secret-slack-bot` / `-secret-teams-webhook` → `{ "webhookUrl" }`

Users self-sign-up in the SPA (email + password, no MFA). Assign a user to a
Cognito group (Lead/SME/Reviewer/Portfolio/Mgmt/Ops) to unlock role-gated
features (review queue, portfolio dashboard).

Three platform users (`hminshen@dsta.gov.sg`, `limjiayivenusw@gmail.com`,
`tayyihsuen@gmail.com`) are provisioned by `deploy.sh` and added to every
persona group on every deploy, so they have full role-gated access without
needing to self-sign-up and be assigned groups manually.

## Testing

```bash
npm install     # jest (dev only)
npm test        # 9 suites / 31 tests
```

Handlers reach AWS only through the `src/lib/*` wrappers, so unit tests mock the
wrappers (via `src/lib/__mocks__/`) and never touch AWS or the SDK. Tests cover
the acceptance criteria: CRUD persistence + relationship edges + the
`initiative-registered` event, submission approve/reject transitions, webhook
signature validation, search response shape, overlap classification
(Strong/Partial/Novel), SME match count (1–3), and the dashboard snapshot shape.

`sam validate --lint` and `sam build` both pass.

## Key decisions & deviations from the reference spec

The `spec/` and `docs/` are the approved reference. `CLAUDE.md` is the
authoritative build contract and supersedes them where they conflict. Notable
choices:

- **Naming.** The spec uses `amgus-{env}-*`; the contract mandates the
  `app-193a359c-027ffd1c-` prefix in `ap-southeast-1`. Every resource uses the
  contract prefix.
- **Function consolidation (9 Lambdas).** The six per-entity CRUD functions are
  one path-routed `fn-crud`; the three ingestion processors are one `fn-ingestion`
  (source inferred from the webhook path / SQS `eventSourceARN` / schedule input).
  This keeps the stack small and deployable while preserving behaviour. IAM is
  still explicit per function with the mandatory permissions boundary.
- **Audit trail.** Written directly to the `audit-log` table via a single-purpose
  shared helper (scoped `PutItem` only) rather than a separate audit-logger
  function — least privilege preserved, one fewer moving part.
- **Ingestion orchestration.** Uses SQS → Lambda directly (validate → index →
  audit) instead of a second Step Functions workflow; the overlap-detection state
  machine (required by the spec) is implemented in full with retry/catch.
- **Edge.** CloudFront hosts the SPA; the SPA calls API Gateway directly with a
  Cognito JWT. `app_url` is the CloudFront domain.
- **SME directory.** No LDAP/AD federation in this MVP — SME profiles live in
  DynamoDB/Cognito (as already flagged in the architecture doc).

## Security notes

- Cognito authenticates every app route; group claims gate reviewer/portfolio
  actions both at the API and in-handler.
- Webhook endpoints are unauthenticated by design but validate a shared secret
  (Jira) or HMAC signature (GitHub) against Secrets Manager before accepting.
- IAM roles are least-privilege with explicit ARNs and the required permissions
  boundary. Bedrock `InvokeModel` is left broad because model access is enforced
  at runtime by Bedrock; S3 Vectors is scoped to the app's vector bucket.
- Buckets block public access; the SPA bucket is readable only by CloudFront via
  an Origin Access Control. Data is encrypted at rest (SSE-S3) and in transit.
