# Resource Inventory
| Resource | AWS Service | Naming Pattern | Purpose |
|----------|-------------|-----------------|---------|
| SPA hosting bucket | Amazon S3 | `amgus-{env}-spa-assets` | Static SPA build artifacts |
| Ingestion staging bucket | Amazon S3 | `amgus-{env}-ingestion-staging` | Raw uploads/webhook payloads pre-validation |
| Document/asset bucket | Amazon S3 | `amgus-{env}-assets` | PDFs, uploaded docs, code/design artifacts |
| Dashboard snapshot bucket | Amazon S3 | `amgus-{env}-dashboard-snapshots` | Weekly analytics snapshot exports |
| CDN | Amazon CloudFront | `amgus-{env}-cdn` | TLS edge for SPA + API origin |
| User pool | Amazon Cognito | `amgus-{env}-user-pool` | Auth for all personas, groups = roles |
| User pool client | Amazon Cognito | `amgus-{env}-spa-client` | SPA app client (Hosted UI) |
| App REST API | Amazon API Gateway | `amgus-{env}-api` | Authenticated app routes (Cognito authorizer) |
| Webhook REST API | Amazon API Gateway | `amgus-{env}-webhooks-api` | Unauthenticated Jira/GitHub webhook receivers, secret-header/HMAC validated |
| Domain CRUD functions | AWS Lambda | `amgus-{env}-fn-{entity}-crud` (entity = problems, initiatives, solutions, findings, assets, sme-profiles) | Entity CRUD + validation |
| Ingestion processor functions | AWS Lambda | `amgus-{env}-fn-ingestion-{source}` (source = jira, confluence, github) | Validate + normalize inbound events |
| Search function | AWS Lambda | `amgus-{env}-fn-search` | Embed query, S3 Vectors search, DynamoDB filter, re-rank |
| Overlap embed/classify functions | AWS Lambda | `amgus-{env}-fn-overlap-embed`, `amgus-{env}-fn-overlap-classify` | Bedrock embedding + Strong/Partial/Novel classification |
| SME router function | AWS Lambda | `amgus-{env}-fn-sme-router` | Match guidance request to 1-3 SMEs |
| Notifier function | AWS Lambda | `amgus-{env}-fn-notifier-slack-teams` | SNS subscriber → Slack/Teams webhook |
| Review/publish function | AWS Lambda | `amgus-{env}-fn-review-publish` | Reviewer approval → publish + index |
| Dashboard aggregator function | AWS Lambda | `amgus-{env}-fn-dashboard-aggregator` | Weekly portfolio stats rollup |
| Audit logger function | AWS Lambda | `amgus-{env}-fn-audit-logger` | Writes AuditLog entries from all domains |
| Overlap detection workflow | AWS Step Functions | `amgus-{env}-sfn-overlap-detection` | Embed → search → classify → persist → notify |
| Ingestion pipeline workflow | AWS Step Functions | `amgus-{env}-sfn-ingestion-pipeline` | Validate → (review or direct) → index → audit |
| Core entity tables | Amazon DynamoDB | `amgus-{env}-{entity}` (entity = problems, initiatives, solutions, findings, assets, sme-profiles) | Entity records |
| Relationships table | Amazon DynamoDB | `amgus-{env}-relationships` | Knowledge graph edges |
| Audit log table | Amazon DynamoDB | `amgus-{env}-audit-log` | CRUD/search/approval/routing audit trail |
| Review queue table | Amazon DynamoDB | `amgus-{env}-review-queue` | Pending manual submissions |
| Analytics snapshot table | Amazon DynamoDB | `amgus-{env}-analytics-snapshot` | Weekly dashboard data |
| Overlap results table | Amazon DynamoDB | `amgus-{env}-overlap-results` | Overlap scores/classifications per initiative pair |
| Vector collections | Amazon S3 Vectors | `amgus-{env}-vectors-{entity}` (one per entity type) | Semantic index + metadata filters |
| Ingestion queues | Amazon SQS | `amgus-{env}-q-ingestion-{source}` + `amgus-{env}-q-ingestion-{source}-dlq` | Decouple webhook receipt from processing |
| Review queue (async) | Amazon SQS | `amgus-{env}-q-review` + `-dlq` | Manual submission → reviewer handoff |
| Notification queue | Amazon SQS | `amgus-{env}-q-notifications` + `-dlq` | Buffer for notifier fan-out |
| Overlap notify topic | Amazon SNS | `amgus-{env}-topic-overlap-notify` | Fan-out overlap results to notifier/nudge consumers |
| SME routing topic | Amazon SNS | `amgus-{env}-topic-sme-routing` | Fan-out guidance-request matches |
| Custom event bus | Amazon EventBridge | `amgus-{env}-bus-events` | Domain events (initiative-registered, etc.) |
| Scheduler rules | Amazon EventBridge | `amgus-{env}-rule-{purpose}` (purpose = confluence-poll, jira-poll, dashboard-weekly) | Scheduled sync/refresh triggers |
| Integration secrets | AWS Secrets Manager | `amgus-{env}-secret-{system}` (system = jira, confluence, github, slack-bot, teams-webhook) | Third-party tokens/webhook URLs |
| Tunable parameters | AWS SSM Parameter Store | `amgus-{env}-param-{name}` (name = overlap-threshold, sync-schedule, feature-flags) | Runtime-tunable config |
| Per-function execution roles | AWS IAM | `amgus-{env}-role-fn-{function-name}` | Least-privilege execution identity per Lambda |
| Log groups | Amazon CloudWatch | `/amgus/{env}/lambda/{function-name}` | 2yr retention structured logs |
| Ops dashboard | Amazon CloudWatch | `amgus-{env}-dashboard-ops` | Cross-service health/latency view |
