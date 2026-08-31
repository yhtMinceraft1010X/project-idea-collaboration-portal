# Design: Digital Hub Technical Knowledge & Collaboration Platform

## Overview
The platform is built as a set of per-domain Lambda functions behind a Cognito-authorized API Gateway, with six core entity tables plus a relationships/audit/review/analytics/overlap-results tables in DynamoDB, and per-entity-type S3 Vectors collections for semantic search and overlap detection. Manual submissions flow through an SQS-backed review queue before Bedrock-driven indexing; Jira/GitHub webhooks and Confluence polling bypass review and index directly after validation. Step Functions orchestrates the overlap-detection workflow (embed → similarity search → classify → notify) and the ingestion validation/publish pipeline, with SNS/Lambda fanning results out to Slack/Teams and in-app nudges. All naming uses the `amgus-{env}-*` convention so the same templates promote cleanly from a single MVP environment to dev/stage/prod.

## Data Model
| Table / Store | Key Schema | Key Attributes | Notes |
|----------------|------------|-----------------|-------|
| `amgus-{env}-problems` | PK `PROBLEM#{problemId}`, SK `METADATA` | title, description, status, creatorId, createdAt, tags | GSI1 `StatusIndex`: PK status, SK createdAt (lifecycle FR-20) |
| `amgus-{env}-initiatives` | PK `INITIATIVE#{initiativeId}`, SK `METADATA` | title, description, leadUserId, ownerTeam, status, linkedProblemId, techStack, createdAt | GSI1 `LeadIndex` (leadUserId/createdAt); GSI2 `ProblemIndex` (linkedProblemId) |
| `amgus-{env}-solutions` | PK `SOLUTION#{solutionId}`, SK `METADATA` | initiativeId, title, description, assetRefs, reuseCount | reuseCount incremented on FR-26 reuse events |
| `amgus-{env}-findings` | PK `FINDING#{findingId}`, SK `METADATA` | initiativeId, sourceSystem, content, tags, createdAt | sourceSystem = manual\|jira\|confluence\|github |
| `amgus-{env}-assets` | PK `ASSET#{assetId}`, SK `METADATA` | s3Key, assetType, sourceSystem, initiativeId | s3Key points to `amgus-{env}-assets` bucket object |
| `amgus-{env}-sme-profiles` | PK `SME#{userId}`, SK `METADATA` | expertiseDomains[], pastContributions[], availability, cognitoGroup | Seeded/synced via CSV per architecture decision (no LDAP in MVP) |
| `amgus-{env}-relationships` | PK `ENTITY#{type}#{id}`, SK `REL#{relatedType}#{relatedId}` | relationType, createdAt | GSI1 `InvertedIndex` (SK-part as PK) for reverse traversal; powers knowledge graph FR-24 |
| `amgus-{env}-audit-log` | PK `AUDIT#{yyyy-mm-dd}`, SK `{epochMs}#{eventId}` | actorId, action, entityRef, details | 2yr retention (NFR compliance) |
| `amgus-{env}-review-queue` | PK `REVIEW#{submissionId}`, SK `METADATA` | entityType, entityId, submitterId, status, submittedAt | GSI1 `StatusIndex` (status/submittedAt) for reviewer worklist |
| `amgus-{env}-analytics-snapshot` | PK `SNAPSHOT#{isoWeek}`, SK `METADATA` | themes, overlapHotspots, reuseRate, gaps | Written weekly by dashboard aggregator |
| `amgus-{env}-overlap-results` | PK `INITIATIVE#{initiativeId}`, SK `OVERLAP#{candidateInitiativeId}` | overlapScore, classification, detectedAt | classification = Strong\|Partial\|Novel |
| `amgus-{env}-vectors-{entity}` (S3 Vectors) | vectorId = `{entity}Id` | embedding, metadata (entityType, tags, status) | One collection per entity type per architecture decision |

## API / Interface Contracts
| Endpoint or Interface | Method | Request | Response | Auth |
|------------------------|--------|---------|----------|------|
| `/problems` | POST | `{title, description, tags}` | `{problemId, status}` | Cognito JWT |
| `/problems/{id}` | GET | path id | Problem record | Cognito JWT |
| `/initiatives` | POST | `{title, description, techStack, linkedProblemId}` | `{initiativeId}` (triggers `initiative-registered` event) | Cognito JWT |
| `/submissions` | POST | `{entityType, templateOrUpload, content}` | `{submissionId, status: "pending"}` | Cognito JWT |
| `/submissions/{id}/approve` | POST | `{decision, comments}` | `{submissionId, status}` | Cognito JWT (Reviewer group) |
| `/search` | POST | `{query, entityTypes?, filters?}` | `{results:[{entityId, entityType, score, snippet}]}` | Cognito JWT |
| `/guidance-requests` | POST | `{query, context}` | `{requestId, matchedSmeIds:[]}` | Cognito JWT |
| `/nudges/{id}/collaborate` | POST | `{action: "link"\|"office-hours"}` | `{status, linkedRef}` | Cognito JWT |
| `/dashboard/portfolio` | GET | query params (week) | Snapshot payload | Cognito JWT (Portfolio/Mgmt group) |
| `/graph/{entityType}/{id}` | GET | path params | `{nodes:[], edges:[]}` | Cognito JWT |
| `/webhooks/jira` | POST | Jira webhook payload | `202 Accepted` | Shared-secret header validated against Secrets Manager |
| `/webhooks/github` | POST | GitHub webhook payload | `202 Accepted` | HMAC signature validated against Secrets Manager |

## Sequence Detail
1. User submits a structured template or upload via the SPA.
2. SPA calls `POST /submissions`; API Gateway invokes `fn-review-publish` (create path).
3. Lambda writes a pending record to `amgus-{env}-review-queue` and enqueues a review task on `amgus-{env}-q-review`.
4. API returns `202 Accepted` with the submission id immediately (async).
5. A Content Reviewer later approves via `/submissions/{id}/approve`, updating status.
6. On approval, Lambda generates a Bedrock embedding and writes the vector to the matching `amgus-{env}-vectors-{entity}` collection.
7. Lambda writes an audit event to `amgus-{env}-audit-log`.
8. `initiative-registered` custom event on `amgus-{env}-bus-events` starts `amgus-{env}-sfn-overlap-detection`.
9. Workflow invokes `fn-overlap-embed`, which embeds the initiative text via Bedrock and upserts it into `amgus-{env}-vectors-initiatives`.
10. Same function runs a similarity search against active initiatives in that collection.
11. Workflow invokes `fn-overlap-classify`, which uses Bedrock (claude-haiku-4-5, escalate to sonnet-5 only for ambiguous cases) to label each candidate Strong/Partial/Novel.
12. Results are persisted to `amgus-{env}-overlap-results`.
13. Workflow publishes to `amgus-{env}-topic-overlap-notify`; `fn-notifier-slack-teams` fans out to Initiative/Portfolio Leads and relevant SMEs via Slack/Teams webhook plus an in-app nudge record.
14. All steps append to `amgus-{env}-audit-log` via `fn-audit-logger`.

## IAM & Access Design
| Principal | Resource | Actions | Justification |
|-----------|----------|---------|----------------|
| `amgus-{env}-role-fn-{entity}-crud` | `amgus-{env}-{entity}` table, `amgus-{env}-relationships` | GetItem/PutItem/Query/UpdateItem | Domain CRUD scoped to its own table + graph edges |
| `amgus-{env}-role-fn-ingestion-{source}` | `amgus-{env}-q-ingestion-{source}`, `amgus-{env}-secret-{source}`, target entity tables | ReceiveMessage/DeleteMessage, GetSecretValue, PutItem | Processes one integration's queue with its own credential |
| `amgus-{env}-role-fn-search` | `amgus-{env}-vectors-*`, all entity tables (read), Bedrock models | Query vectors, GetItem/Query, InvokeModel | Cross-entity semantic + metadata search |
| `amgus-{env}-role-fn-overlap-embed` / `-classify` | `amgus-{env}-vectors-initiatives`, `amgus-{env}-overlap-results`, Bedrock | Query/Put vectors, PutItem, InvokeModel | Overlap workflow isolated to initiatives vectors + results table |
| `amgus-{env}-role-fn-sme-router` | `amgus-{env}-sme-profiles`, `amgus-{env}-vectors-sme`, `amgus-{env}-topic-sme-routing` | GetItem/Query, Query vectors, Publish | Matches + fans out guidance requests |
| `amgus-{env}-role-fn-notifier-slack-teams` | `amgus-{env}-secret-slack-bot`, `amgus-{env}-secret-teams-webhook`, SNS topics (subscribe) | GetSecretValue, Receive | Outbound webhook delivery only |
| `amgus-{env}-role-fn-review-publish` | `amgus-{env}-review-queue`, target entity tables, `amgus-{env}-vectors-*` | GetItem/UpdateItem/PutItem, Put vectors | Publishes approved content + indexes it |
| `amgus-{env}-role-fn-dashboard-aggregator` | all entity tables (read), `amgus-{env}-analytics-snapshot`, `amgus-{env}-dashboard-snapshots` bucket | Query (read-only), PutItem, PutObject | Weekly read-only rollup, single write target |
| `amgus-{env}-role-fn-audit-logger` | `amgus-{env}-audit-log` | PutItem | Single-purpose append-only writer |
| `amgus-{env}-role-sfn-overlap-detection` | overlap embed/classify Lambdas, `amgus-{env}-topic-overlap-notify` | InvokeFunction, Publish | Orchestration role, no direct data access |
| Cognito groups (Lead/SME/Reviewer/Portfolio/Mgmt/Ops) | API Gateway routes | Route-level authorization via Cognito authorizer scopes | Enforces persona-based access at the edge; Lambda re-checks group claim for group-gated actions |

## Error Handling & Observability
| Concern | Approach |
|---------|----------|
| Retries/idempotency | SQS-backed queues (`-dlq` per queue) with Lambda-side idempotency keys (submissionId/eventId) enforced via DynamoDB conditional writes; Step Functions retry policies (exponential backoff, 3 attempts) on Bedrock/S3 Vectors calls |
| Failure alerting | CloudWatch Alarms on DLQ depth > 0 and Lambda error rate; alarm actions publish to an ops SNS topic notifying Platform Operators |
| Logging | Structured JSON logs from every Lambda to `/amgus/{env}/lambda/{function-name}`, 2-year retention per audit requirement |
| Tracing | AWS X-Ray enabled end-to-end (API Gateway → Lambda → Step Functions → downstream calls) to diagnose the <3s search / <1h SME-routing SLAs |
| Ingestion validation failures | Malformed webhook/poll payloads routed to source-specific DLQ; flagged in `amgus-{env}-review-queue` with status `validation-failed` for manual triage |
| Step Functions error branches | Catch blocks on Bedrock/S3 Vectors/DynamoDB failures route to a `NotifyOpsAndFail` state rather than silently stalling the workflow |
