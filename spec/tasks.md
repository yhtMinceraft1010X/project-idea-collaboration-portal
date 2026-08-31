# Implementation Tasks: Digital Hub Technical Knowledge & Collaboration Platform

- [ ] 1. Create SPA hosting, staging, assets, and dashboard-snapshot S3 buckets
  - `amgus-{env}-spa-assets`, `amgus-{env}-ingestion-staging`, `amgus-{env}-assets`, `amgus-{env}-dashboard-snapshots`
  - _Requirements: 1, 2, 3, 8_
  - _Verify: `sam validate` succeeds against the template defining these bucket resources_

- [ ] 2. Configure CloudFront distribution for SPA + API origin
  - `amgus-{env}-cdn` with S3 (SPA) and API Gateway origins
  - _Requirements: 9_
  - _Verify: template lint confirms distribution resource references both origins_

- [ ] 3. Configure Cognito User Pool and app client
  - `amgus-{env}-user-pool`, `amgus-{env}-spa-client`, groups for Lead/SME/Reviewer/Portfolio/Mgmt/Ops
  - _Requirements: 9_
  - _Verify: unit test asserts all six group names are defined in the pool config_

- [ ] 4. Create app REST API and webhook REST API in API Gateway
  - `amgus-{env}-api` (Cognito authorizer), `amgus-{env}-webhooks-api` (secret-header/HMAC validation)
  - _Requirements: 3, 9_
  - _Verify: `sam validate` succeeds; unit test confirms authorizer attached to `amgus-{env}-api` routes_

- [ ] 5. Implement domain CRUD Lambda functions and entity tables
  - `amgus-{env}-fn-{entity}-crud` for problems/initiatives/solutions/findings/assets/sme-profiles against `amgus-{env}-{entity}` tables
  - _Requirements: 1_
  - _Verify: unit tests pass for each CRUD handler against a local DynamoDB mock_

- [ ] 6. Implement relationships table and graph edge writes
  - `amgus-{env}-relationships` with `InvertedIndex` GSI, written on initiative-problem linking
  - _Requirements: 1, 8_
  - _Verify: unit test confirms edge item written with correct PK/SK on linking call_

- [ ] 7. Implement audit logger function and audit log table
  - `amgus-{env}-fn-audit-logger` writing to `amgus-{env}-audit-log`
  - _Requirements: 1, 6, 7, 10_
  - _Verify: unit test confirms PutItem call shape for a sample audit event_

- [ ] 8. Implement review queue table and submission/review-publish flow
  - `amgus-{env}-review-queue`, `amgus-{env}-q-review` + DLQ, `amgus-{env}-fn-review-publish`
  - _Requirements: 2_
  - _Verify: unit test confirms status transitions pending→approved/rejected_

- [ ] 9. Implement ingestion processor functions and queues for Jira/Confluence/GitHub
  - `amgus-{env}-fn-ingestion-{source}`, `amgus-{env}-q-ingestion-{source}` + DLQ
  - _Requirements: 3_
  - _Verify: unit test confirms webhook signature/secret validation rejects tampered payloads_

- [ ] 10. Implement EventBridge scheduler rules for Confluence poll, Jira poll, and weekly dashboard
  - `amgus-{env}-rule-confluence-poll`, `amgus-{env}-rule-jira-poll`, `amgus-{env}-rule-dashboard-weekly`
  - _Requirements: 3, 8_
  - _Blocked by: OED-1 (Confluence poll frequency)_
  - _Verify: `sam validate` succeeds against the template defining these rules_

- [ ] 11. Create S3 Vectors collections per entity type
  - `amgus-{env}-vectors-{entity}` for problems/initiatives/solutions/findings/assets/sme-profiles
  - _Requirements: 2, 3, 4, 5, 7_
  - _Verify: template lint confirms one collection resource per entity type_

- [ ] 12. Implement search Lambda function
  - `amgus-{env}-fn-search`: Bedrock embed query → S3 Vectors search → DynamoDB filter → re-rank
  - _Requirements: 4_
  - _Verify: unit test confirms response shape `{results:[...]}` for a mocked query_

- [ ] 13. Implement overlap-embed and overlap-classify Lambda functions
  - `amgus-{env}-fn-overlap-embed`, `amgus-{env}-fn-overlap-classify`, writing to `amgus-{env}-overlap-results`
  - _Requirements: 5_
  - _Blocked by: OED-2 (overlap similarity threshold)_
  - _Verify: unit test confirms classification output is one of Strong/Partial/Novel_

- [ ] 14. Implement overlap-detection Step Functions workflow
  - `amgus-{env}-sfn-overlap-detection` orchestrating embed → search → classify → persist → notify with retry/catch branches
  - _Requirements: 5, 10_
  - _Verify: `sam validate`/ASL linter confirms state machine definition is well-formed with Catch blocks present_

- [ ] 15. Implement ingestion validation/publish Step Functions workflow
  - `amgus-{env}-sfn-ingestion-pipeline`
  - _Requirements: 2, 3_
  - _Verify: ASL linter confirms state machine definition is well-formed_

- [ ] 16. Implement SNS topics and notifier Lambda for overlap + SME routing
  - `amgus-{env}-topic-overlap-notify`, `amgus-{env}-topic-sme-routing`, `amgus-{env}-fn-notifier-slack-teams`
  - _Requirements: 5, 7_
  - _Verify: unit test confirms notifier calls Slack/Teams webhook URL retrieved from Secrets Manager mock_

- [ ] 17. Implement SME router Lambda function and 1-click collaboration endpoint
  - `amgus-{env}-fn-sme-router`, `POST /guidance-requests`, `POST /nudges/{id}/collaborate`
  - _Requirements: 6, 7_
  - _Blocked by: OED-3 (SME matching weighting)_
  - _Verify: unit test confirms matched SME count is between 1 and 3_

- [ ] 18. Implement dashboard aggregator Lambda and analytics snapshot table
  - `amgus-{env}-fn-dashboard-aggregator`, `amgus-{env}-analytics-snapshot`, `GET /dashboard/portfolio`
  - _Requirements: 8_
  - _Verify: unit test confirms snapshot item written with themes/overlapHotspots/reuseRate/gaps keys_

- [ ] 19. Implement knowledge graph endpoint
  - `GET /graph/{entityType}/{id}` reading from `amgus-{env}-relationships`
  - _Requirements: 8_
  - _Verify: unit test confirms response shape `{nodes:[], edges:[]}`_

- [ ] 20. Configure Secrets Manager entries and SSM parameters
  - `amgus-{env}-secret-{system}` for jira/confluence/github/slack-bot/teams-webhook; `amgus-{env}-param-{name}` for overlap-threshold/sync-schedule/feature-flags
  - _Requirements: 3, 5, 7_
  - _Verify: template lint confirms all five secret resources and three parameter resources are declared_

- [ ] 21. Configure CloudWatch log groups, alarms, ops dashboard, and X-Ray tracing
  - `/amgus/{env}/lambda/{function-name}` log groups, DLQ-depth and error-rate alarms, `amgus-{env}-dashboard-ops`, X-Ray enabled on API Gateway/Lambda/Step Functions
  - _Requirements: 10_
  - _Verify: template lint confirms X-Ray tracing config is set on all Lambda and Step Functions resources_

- [ ] 22. Wire IAM role for domain CRUD Lambdas (`amgus-{env}-role-fn-{entity}-crud`)
  - Scope to own entity table + relationships table
  - _Requirements: 1_
  - _Verify: IAM policy linter confirms no wildcard resource ARNs_

- [ ] 23. Wire IAM role for ingestion processor Lambdas (`amgus-{env}-role-fn-ingestion-{source}`)
  - Scope to own SQS queue, own secret, target entity tables
  - _Requirements: 3_
  - _Verify: IAM policy linter confirms no wildcard resource ARNs_

- [ ] 24. Wire IAM role for search Lambda (`amgus-{env}-role-fn-search`)
  - Scope to all vector collections (read), all entity tables (read), Bedrock InvokeModel
  - _Requirements: 4_
  - _Verify: IAM policy linter confirms read-only Dynamo actions (no Put/Update/Delete)_

- [ ] 25. Wire IAM roles for overlap embed/classify Lambdas (`amgus-{env}-role-fn-overlap-embed`, `-classify`)
  - Scope to initiatives vector collection, overlap-results table, Bedrock InvokeModel
  - _Requirements: 5_
  - _Verify: IAM policy linter confirms resource scope excludes unrelated tables_

- [ ] 26. Wire IAM role for SME router Lambda (`amgus-{env}-role-fn-sme-router`)
  - Scope to sme-profiles table, sme vector collection, sme-routing SNS topic
  - _Requirements: 7_
  - _Verify: IAM policy linter confirms Publish action scoped to single topic ARN_

- [ ] 27. Wire IAM role for notifier Lambda (`amgus-{env}-role-fn-notifier-slack-teams`)
  - Scope to slack-bot and teams-webhook secrets, SNS subscribe
  - _Requirements: 5, 7_
  - _Verify: IAM policy linter confirms GetSecretValue scoped to named secrets only_

- [ ] 28. Wire IAM role for review/publish Lambda (`amgus-{env}-role-fn-review-publish`)
  - Scope to review-queue table, entity tables, vector collections write
  - _Requirements: 2_
  - _Verify: IAM policy linter confirms scope matches Resource Inventory row_

- [ ] 29. Wire IAM role for dashboard aggregator Lambda (`amgus-{env}-role-fn-dashboard-aggregator`)
  - Read-only on entity tables, write to analytics-snapshot table and dashboard-snapshots bucket
  - _Requirements: 8_
  - _Verify: IAM policy linter confirms only one write-capable resource (analytics-snapshot + bucket)_

- [ ] 30. Wire IAM role for audit logger Lambda (`amgus-{env}-role-fn-audit-logger`)
  - PutItem only on audit-log table
  - _Requirements: 1, 6, 7, 10_
  - _Verify: IAM policy linter confirms single action (PutItem) on single resource_

- [ ] 31. Wire IAM role for overlap-detection Step Functions (`amgus-{env}-role-sfn-overlap-detection`)
  - InvokeFunction on embed/classify Lambdas, Publish on overlap-notify topic
  - _Requirements: 5_
  - _Verify: IAM policy linter confirms no direct DynamoDB/S3 permissions on this role_
