# Architecture: Digital Hub Technical Knowledge & Collaboration Platform
Data Sensitivity: Internal | Pattern: Event-driven serverless with async ingestion pipelines

## Solution Summary
A serverless web platform on AWS ingests knowledge (Problems, Initiatives, Solutions, Findings, Assets, SME Profiles) via manual submission and automated webhooks/sync from Jira, Confluence and GitHub, storing structured data in DynamoDB and documents in S3. Amazon Bedrock generates embeddings and Amazon S3 Vectors provides semantic + hybrid search and overlap detection, orchestrated by Step Functions and EventBridge, with results surfaced as smart nudges and routed to SMEs/Slack/Teams via SQS/SNS/Lambda. Cognito provides standalone authentication/authorization for all internal user personas, API Gateway + Lambda serve the SPA (hosted on S3/CloudFront), and CloudWatch/DynamoDB capture a full audit trail. This is an internet-accessible MVP/POC using existing pre-provisioned VPC/subnets, standard TLS + Cognito-based security in place of private networking.

## AWS Services
| Service | Purpose | Config Notes |
|---------|---------|---------------|
| Amazon Cognito | Standalone IdP for all 8 user personas | User Pool + Hosted UI, groups map to roles (Lead, SME, Reviewer, Portfolio, Mgmt, Ops) |
| Amazon CloudFront | CDN + TLS edge for SPA and API | Origin = S3 (SPA) + API Gateway |
| Amazon S3 | SPA hosting, document/asset uploads, ingestion staging, dashboard snapshots | Separate buckets per purpose |
| Amazon API Gateway | REST API for app + webhook receivers (Jira/GitHub) | Cognito authorizer on app routes; separate unauthenticated webhook routes secured via secret headers |
| AWS Lambda | All business logic: CRUD, ingestion processors, search, routing, notifications, analytics | Node/Python runtimes, per-domain functions |
| AWS Step Functions | Overlap detection workflow; ingestion validation/publish pipeline | Standard workflows, retries/error branches |
| Amazon DynamoDB | 6 entity tables + relationships(knowledge graph)/audit log/review-queue/analytics-snapshot tables | On-demand capacity |
| Amazon S3 Vectors | Semantic search & overlap-detection vector index (substitute for OpenSearch — not in allowed list) | One vector collection per entity type, metadata filters for hybrid full-text-like search |
| Amazon Bedrock | Embeddings (cohere.embed-multilingual-v3), semantic re-rank/overlap classification (claude-haiku-4-5), heavier NLP tasks (claude-sonnet-5 sparingly) | Invoked from Lambda/Step Functions |
| Amazon SQS | Decouple ingestion events, review queue, notification queue | DLQ per queue |
| Amazon SNS | Fan-out overlap/SME-routing notifications to notifier Lambdas | Topic per notification type |
| Amazon EventBridge | Scheduled Confluence/Jira polling, weekly dashboard refresh, new-initiative-registered trigger | Rules + custom event bus |
| AWS Secrets Manager | Jira/Confluence/GitHub API tokens, Slack/Teams bot tokens/webhook URLs | Rotation where supported |
| AWS Systems Manager Parameter Store | Overlap thresholds, sync schedules, feature flags | Standard params |
| AWS IAM | Least-privilege roles for Lambda/Step Functions/API Gateway | Per-function roles |
| Amazon CloudWatch | Logs, metrics, alarms, dashboards; audit log export | Log groups w/ 2yr retention policy |
| AWS X-Ray | Distributed tracing across API Gateway → Lambda → Step Functions | Enabled on all traced services |

## Data Flow
1. **Auth**: User → CloudFront → SPA (S3) → Cognito Hosted UI login → JWT → API Gateway (Cognito authorizer) → Lambda → DynamoDB/S3.
2. **Manual contribution (FR-07/08/12)**: User submits template/upload via SPA → API Gateway → Lambda validates → draft stored in DynamoDB + S3 → SQS review queue → Content Reviewer approves in UI → Lambda publishes → Bedrock generates embeddings → indexed in S3 Vectors → audit event written to DynamoDB.
3. **Auto-ingestion (FR-09/10/11/13)**: Jira/GitHub webhook or Confluence EventBridge-scheduled poll → API Gateway/Lambda → SQS → processor Lambda validates → DynamoDB + S3 Vectors index (no reviewer step) → audit event logged.
4. **Overlap detection (FR-03/04/05)**: New initiative registered → EventBridge event → Step Functions workflow → Bedrock embeds text → S3 Vectors similarity search across active initiatives → Bedrock classifies Strong/Partial/Novel → results stored in DynamoDB → SNS → Lambda notifies Initiative/Portfolio Leads + SMEs via Slack/Teams webhook + in-app nudge.
5. **1-click collaboration (FR-06)**: User action on nudge → API Gateway → Lambda links initiatives/logs RFC/SME office-hours reference in DynamoDB.
6. **Search (FR-14/15, NFR-01)**: Query → API Gateway → Lambda → Bedrock embeds query → S3 Vectors similarity search + DynamoDB metadata filter → Bedrock re-ranks top results → response < 3s.
7. **SME routing (FR-16/17/18)**: Guidance request → API Gateway → Lambda matches via SME DynamoDB profiles + S3 Vectors expertise similarity → SNS → Lambda posts to Slack/Teams → routing event logged to audit DynamoDB.
8. **Portfolio dashboard (FR-22/23, NFR-08)**: EventBridge weekly schedule → Lambda aggregates DynamoDB stats (themes, overlaps, reuse rate) → snapshot to S3/DynamoDB → Portfolio Leads/Mgmt view via SPA/API Gateway.
9. **Knowledge graph (FR-24)**: Relationship edges maintained in DynamoDB on every write; API Gateway/Lambda serves graph data to SPA visualization component.

## Design Decisions
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Vector/semantic search engine | Amazon S3 Vectors (not OpenSearch) | OpenSearch not in allowed services list; S3 Vectors is the mandated substitute, meets FR-03/FR-14 |
| Full-text search | Hybrid: DynamoDB metadata filters + S3 Vectors similarity | No dedicated full-text engine allowed; hybrid approach approximates FR-14/NFR-04 |
| Embeddings/re-ranking model | cohere.embed-multilingual-v3 + claude-haiku-4-5 | Lowest-cost approved models satisfy NFR-01 latency and cost goals |
| Auth/identity | Cognito standalone User Pool (per feedback) | Replaces LDAP federation for MVP; simplifies build, satisfies SSO-like requirement for User Base table |
| SME profile source | Cognito custom attributes + DynamoDB SME table, manually/CSV seeded | No internal directory integration in this POC; deviates from BRD FR-19/CON-02 (flagged below) |
| Compute model | Lambda + Step Functions (serverless) | Matches usage scale (50-300 concurrent users), no persistent servers needed, satisfies NFR-11 |
| Ingestion decoupling | SQS between webhook receivers and processors | Handles bursty Jira/GitHub webhook traffic (CON-06/CON-07), supports async consistency |
| Notification delivery | SNS + Lambda → Slack/Teams webhook | SNS has no native Slack/Teams target; Lambda subscriber calls webhook (CON-05) |
| Overlap detection cadence | EventBridge event-driven + Step Functions workflow | Meets NFR-02 (scan within 2 weeks, notify within 24h) |
| Network posture | Public internet-accessible via CloudFront + Cognito auth, existing VPC/subnets referenced for any VPC-bound resources | Per feedback #1: skip private networking for MVP |
| Perimeter protection | CloudFront + Cognito + API Gateway throttling (no AWS WAF — not in allowed list) | Closest available substitute; noted limitation for MVP |
| Audit trail storage | Dedicated DynamoDB AuditLog table + CloudWatch Logs | Satisfies full audit trail requirement, 2yr retention (NFR compliance) |

## Security Design
| Concern | Approach |
|---------|----------|
| Authentication | Amazon Cognito User Pool (Hosted UI), JWT issued to SPA, all personas authenticate via SSO-equivalent login |
| Authorisation | Cognito Groups mapped to personas (Lead, Contributor, SME, Reviewer, Portfolio, Mgmt, Ops); enforced via API Gateway Cognito authorizer + Lambda-side role checks |
| Data at rest | DynamoDB, S3, S3 Vectors encrypted with AWS-managed KMS keys by default |
| Data in transit | TLS 1.2+ enforced end-to-end: CloudFront↔client, CloudFront↔API Gateway, API Gateway↔Lambda, Lambda↔DynamoDB/S3/Bedrock |
| Network boundary | Public internet-facing via CloudFront/API Gateway (no VPN/private restriction per MVP scope); webhook endpoints protected by shared-secret headers + Secrets Manager validation |
| Secrets | AWS Secrets Manager for Jira/Confluence/GitHub tokens and Slack/Teams bot credentials; no secrets in code/env vars |
| Audit trail | DynamoDB AuditLog table capturing all CRUD, search, submission, approval, routing, and integration sync events; CloudWatch Logs for system-level traces; 2-year retention |

## Integration Confirmation
| System | Direction | Endpoint Type | Auth | Notes |
|--------|-----------|---------------|------|-------|
| Jira | Inbound | REST API webhook + API Gateway | Secrets Manager token/shared secret | As per BRD; async via SQS |
| Confluence | Inbound | REST API, EventBridge-scheduled Lambda poll | Secrets Manager token | As per BRD; scheduled sync (no native push) |
| GitHub | Inbound | REST API webhook + API Gateway | Secrets Manager token/HMAC signature | As per BRD |
| Slack / Microsoft Teams | Outbound | REST API webhook via Lambda (subscribed to SNS) | Secrets Manager bot token/webhook URL | As per BRD |
| Internal Directory (LDAP/AD/HR) | **Not integrated** | N/A | N/A | **Deviation from BRD**: per user feedback, Cognito holds users/SME profiles directly for this MVP instead of federating LDAP/AD (impacts FR-19, CON-02) — flagged for stakeholder confirmation |
