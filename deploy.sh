#!/usr/bin/env bash
#
# deploy.sh - build and deploy the DSTA Knowledge & Collaboration Platform.
#
# Idempotent. Exits non-zero on failure. Writes outputs.json (including app_url)
# at the repo root on success. Run by the platform's build system.
#
# Order of operations (see CLAUDE.md):
#   1. Ensure the deploy-artifacts S3 bucket exists (never use --resolve-s3).
#   2. Ensure the S3 Vectors bucket + one index per entity exist (CLI, not CFN -
#      the same "not a CloudFormation resource" pattern the contract uses for ECR).
#   3. npm install (so any later `npm ci` has a fresh lockfile), then sam build.
#   4. sam deploy into the app-193a359c-027ffd1c-portal stack.
#   5. Ensure the platform users exist and belong to every persona group
#      (AdminCreateUser/AdminAddUserToGroup - not expressible in CloudFormation,
#      same "idempotent CLI call" pattern used for the S3 Vectors bucket above).
#   5b. Seed demo problems/initiatives for four programme themes, owned by the
#       tayyihsuen@gmail.com platform user, via conditional put-item calls.
#   6. Generate frontend/config.js from stack outputs, upload the SPA, invalidate
#      CloudFront, and write outputs.json.

set -euo pipefail

REGION="ap-southeast-1"
PREFIX="app-193a359c-027ffd1c-"
STACK="${PREFIX}portal"
ARTIFACTS_BUCKET="${PREFIX}artifacts"
VECTOR_BUCKET="${PREFIX}vectors"
ENTITIES="problems initiatives solutions findings assets sme-profiles"
EMBED_DIM="1024"
PLATFORM_USERS="hminshen@dsta.gov.sg limjiayivenusw@gmail.com tayyihsuen@gmail.com"
PLATFORM_GROUPS="Lead SME Reviewer Portfolio Mgmt Ops"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

log() { echo "[deploy] $*"; }

# ---------------------------------------------------------------------------
# 1. Deploy-artifacts bucket
# ---------------------------------------------------------------------------
log "Ensuring artifacts bucket ${ARTIFACTS_BUCKET} exists"
if ! aws s3api head-bucket --bucket "$ARTIFACTS_BUCKET" 2>/dev/null; then
  aws s3api create-bucket \
    --bucket "$ARTIFACTS_BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  aws s3api put-bucket-encryption \
    --bucket "$ARTIFACTS_BUCKET" \
    --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' || true
fi

# ---------------------------------------------------------------------------
# 2. S3 Vectors bucket + per-entity indexes (idempotent, via the s3vectors CLI)
# ---------------------------------------------------------------------------
log "Ensuring S3 Vectors bucket ${VECTOR_BUCKET} exists"
if ! aws s3vectors get-vector-bucket --vector-bucket-name "$VECTOR_BUCKET" --region "$REGION" >/dev/null 2>&1; then
  aws s3vectors create-vector-bucket --vector-bucket-name "$VECTOR_BUCKET" --region "$REGION"
fi

for ENTITY in $ENTITIES; do
  if ! aws s3vectors get-index --vector-bucket-name "$VECTOR_BUCKET" --index-name "$ENTITY" --region "$REGION" >/dev/null 2>&1; then
    log "Creating vector index ${ENTITY}"
    aws s3vectors create-index \
      --vector-bucket-name "$VECTOR_BUCKET" \
      --index-name "$ENTITY" \
      --data-type float32 \
      --dimension "$EMBED_DIM" \
      --distance-metric cosine \
      --metadata-configuration '{"nonFilterableMetadataKeys":["snippet"]}' \
      --region "$REGION"
  fi
done

# ---------------------------------------------------------------------------
# 3. Install dependencies (fresh lockfiles) then build
# ---------------------------------------------------------------------------
log "Installing layer + function dependencies"
( cd layer && npm install --no-audit --no-fund )
( cd src && npm install --no-audit --no-fund )

log "sam build"
sam build --region "$REGION"

# ---------------------------------------------------------------------------
# 4. Deploy the CloudFormation/SAM stack
# ---------------------------------------------------------------------------
log "sam deploy -> ${STACK}"
sam deploy \
  --stack-name "$STACK" \
  --s3-bucket "$ARTIFACTS_BUCKET" \
  --s3-prefix "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --no-progressbar

# ---------------------------------------------------------------------------
# Post-deploy: read stack outputs.
# ---------------------------------------------------------------------------
log "Reading stack outputs"
OUTPUTS_JSON="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query 'Stacks[0].Outputs' --output json)"

out() { echo "$OUTPUTS_JSON" | jq -r --arg k "$1" '(.[] | select(.OutputKey==$k) | .OutputValue) // ""'; }

APP_URL="$(out AppUrl)"
API_URL="$(out ApiUrl)"
WEBHOOK_API_URL="$(out WebhookApiUrl)"
USER_POOL_ID="$(out UserPoolId)"
USER_POOL_CLIENT_ID="$(out UserPoolClientId)"
COGNITO_DOMAIN="$(out CognitoDomain)"
SPA_BUCKET="$(out SpaBucketName)"
DISTRIBUTION_ID="$(out DistributionId)"

# ---------------------------------------------------------------------------
# 5. Ensure platform users exist and are members of every persona group.
#    AdminCreateUser/AdminAddUserToGroup have no CloudFormation resource type,
#    so - like the S3 Vectors bucket/indexes above - they're managed here with
#    idempotent CLI calls rather than in template.yaml.
# ---------------------------------------------------------------------------
if [ -n "$USER_POOL_ID" ]; then
  for USER_EMAIL in $PLATFORM_USERS; do
    if ! aws cognito-idp admin-get-user \
      --user-pool-id "$USER_POOL_ID" \
      --username "$USER_EMAIL" \
      --region "$REGION" >/dev/null 2>&1; then
      log "Creating Cognito user ${USER_EMAIL}"
      aws cognito-idp admin-create-user \
        --user-pool-id "$USER_POOL_ID" \
        --username "$USER_EMAIL" \
        --user-attributes Name=email,Value="$USER_EMAIL" Name=email_verified,Value=true \
        --desired-delivery-mediums EMAIL \
        --region "$REGION" >/dev/null
    fi

    for GROUP_NAME in $PLATFORM_GROUPS; do
      log "Ensuring ${USER_EMAIL} is a member of group ${GROUP_NAME}"
      aws cognito-idp admin-add-user-to-group \
        --user-pool-id "$USER_POOL_ID" \
        --username "$USER_EMAIL" \
        --group-name "$GROUP_NAME" \
        --region "$REGION"
    done
  done
else
  log "WARNING: UserPoolId output missing; skipping platform user/group setup"
fi

# ---------------------------------------------------------------------------
# 5b. Seed demo problems/initiatives for four programme themes. Idempotent:
#     each row has a fixed, human-readable id and is written with a
#     conditional put-item, so repeated deploys neither duplicate the seed
#     rows nor touch any pre-existing data. Creator is the platform user
#     tayyihsuen@gmail.com (created/grouped in step 5 above).
# ---------------------------------------------------------------------------
SEED_USER_EMAIL="tayyihsuen@gmail.com"
PROBLEMS_TABLE="${PREFIX}problems"
INITIATIVES_TABLE="${PREFIX}initiatives"
RELATIONSHIPS_TABLE="${PREFIX}relationships"

if [ -n "$USER_POOL_ID" ]; then
  SEED_USER_SUB="$(aws cognito-idp admin-get-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$SEED_USER_EMAIL" \
    --region "$REGION" \
    --query "UserAttributes[?Name=='sub'].Value | [0]" \
    --output text 2>/dev/null || true)"

  if [ -n "$SEED_USER_SUB" ] && [ "$SEED_USER_SUB" != "None" ]; then
    NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

    seed_item() {
      local table="$1" item="$2" label="$3"
      if aws dynamodb put-item \
        --table-name "$table" \
        --region "$REGION" \
        --condition-expression 'attribute_not_exists(pk)' \
        --item "$item" >/dev/null 2>&1; then
        log "Seeded ${label}"
      else
        log "Seed ${label} already present; skipping"
      fi
    }

    # Theme 1: Enterprise LLM Gateway
    seed_item "$PROBLEMS_TABLE" "$(cat <<JSON
{"pk":{"S":"PROBLEM#seed-llm-gateway-problem"},"sk":{"S":"METADATA"},"entityType":{"S":"problems"},"entityId":{"S":"seed-llm-gateway-problem"},"status":{"S":"published"},"createdAt":{"S":"${NOW}"},"updatedAt":{"S":"${NOW}"},"title":{"S":"Enterprise-wide LLM guardrails and model routing"},"description":{"S":"Many teams face the problem of setting up guardrails to meet enterprise compliance policy as well as configuring model routing for the foundation models they call."},"tags":{"L":[{"S":"llm"},{"S":"governance"},{"S":"compliance"}]},"creatorId":{"S":"${SEED_USER_SUB}"},"creatorUsername":{"S":"${SEED_USER_EMAIL}"}}
JSON
)" "PROBLEM#seed-llm-gateway-problem"
    seed_item "$INITIATIVES_TABLE" "$(cat <<JSON
{"pk":{"S":"INITIATIVE#seed-llm-gateway-initiative"},"sk":{"S":"METADATA"},"entityType":{"S":"initiatives"},"entityId":{"S":"seed-llm-gateway-initiative"},"status":{"S":"published"},"createdAt":{"S":"${NOW}"},"updatedAt":{"S":"${NOW}"},"title":{"S":"Enterprise LLM Gateway"},"description":{"S":"One team has stepped up and created an LLM Gateway that can be used enterprise-wide, giving every other team centralised guardrails and model routing out of the box."},"techStack":{"S":"API Gateway, Lambda, Bedrock"},"leadUserId":{"S":"${SEED_USER_SUB}"},"linkedProblemId":{"S":"seed-llm-gateway-problem"},"creatorId":{"S":"${SEED_USER_SUB}"},"creatorUsername":{"S":"${SEED_USER_EMAIL}"}}
JSON
)" "INITIATIVE#seed-llm-gateway-initiative"
    seed_item "$RELATIONSHIPS_TABLE" "$(cat <<JSON
{"pk":{"S":"ENTITY#initiatives#seed-llm-gateway-initiative"},"sk":{"S":"REL#problems#seed-llm-gateway-problem"},"relationType":{"S":"addresses"},"sourceType":{"S":"initiatives"},"sourceId":{"S":"seed-llm-gateway-initiative"},"relatedType":{"S":"problems"},"relatedId":{"S":"seed-llm-gateway-problem"},"createdAt":{"S":"${NOW}"}}
JSON
)" "REL seed-llm-gateway-initiative->problem"

    # Theme 2: MCP Server
    seed_item "$PROBLEMS_TABLE" "$(cat <<JSON
{"pk":{"S":"PROBLEM#seed-mcp-server-problem"},"sk":{"S":"METADATA"},"entityType":{"S":"problems"},"entityId":{"S":"seed-mcp-server-problem"},"status":{"S":"published"},"createdAt":{"S":"${NOW}"},"updatedAt":{"S":"${NOW}"},"title":{"S":"Overlapping MCP server tools across teams"},"description":{"S":"Teams increasingly run their own MCP servers as agent tools, but there is a great overlap between tools such as web search, leading to duplicated build and maintenance effort."},"tags":{"L":[{"S":"mcp"},{"S":"agents"},{"S":"tooling"}]},"creatorId":{"S":"${SEED_USER_SUB}"},"creatorUsername":{"S":"${SEED_USER_EMAIL}"}}
JSON
)" "PROBLEM#seed-mcp-server-problem"
    seed_item "$INITIATIVES_TABLE" "$(cat <<JSON
{"pk":{"S":"INITIATIVE#seed-mcp-server-initiative"},"sk":{"S":"METADATA"},"entityType":{"S":"initiatives"},"entityId":{"S":"seed-mcp-server-initiative"},"status":{"S":"published"},"createdAt":{"S":"${NOW}"},"updatedAt":{"S":"${NOW}"},"title":{"S":"Shared MCP Server Catalogue"},"description":{"S":"A shared catalogue of MCP server tools (starting with web search) so teams reuse a single hardened implementation instead of building their own overlapping versions."},"techStack":{"S":"MCP, Lambda, API Gateway"},"leadUserId":{"S":"${SEED_USER_SUB}"},"linkedProblemId":{"S":"seed-mcp-server-problem"},"creatorId":{"S":"${SEED_USER_SUB}"},"creatorUsername":{"S":"${SEED_USER_EMAIL}"}}
JSON
)" "INITIATIVE#seed-mcp-server-initiative"
    seed_item "$RELATIONSHIPS_TABLE" "$(cat <<JSON
{"pk":{"S":"ENTITY#initiatives#seed-mcp-server-initiative"},"sk":{"S":"REL#problems#seed-mcp-server-problem"},"relationType":{"S":"addresses"},"sourceType":{"S":"initiatives"},"sourceId":{"S":"seed-mcp-server-initiative"},"relatedType":{"S":"problems"},"relatedId":{"S":"seed-mcp-server-problem"},"createdAt":{"S":"${NOW}"}}
JSON
)" "REL seed-mcp-server-initiative->problem"

    # Theme 3: Infrastructure as Code templates
    seed_item "$PROBLEMS_TABLE" "$(cat <<JSON
{"pk":{"S":"PROBLEM#seed-iac-templates-problem"},"sk":{"S":"METADATA"},"entityType":{"S":"problems"},"entityId":{"S":"seed-iac-templates-problem"},"status":{"S":"published"},"createdAt":{"S":"${NOW}"},"updatedAt":{"S":"${NOW}"},"title":{"S":"Every team re-does infrastructure hardening from scratch"},"description":{"S":"Teams spinning up new infrastructure each have to work out their own hardening and compliance checks, repeating the same effort and risking inconsistent security postures."},"tags":{"L":[{"S":"iac"},{"S":"compliance"},{"S":"security"}]},"creatorId":{"S":"${SEED_USER_SUB}"},"creatorUsername":{"S":"${SEED_USER_EMAIL}"}}
JSON
)" "PROBLEM#seed-iac-templates-problem"
    seed_item "$INITIATIVES_TABLE" "$(cat <<JSON
{"pk":{"S":"INITIATIVE#seed-iac-templates-initiative"},"sk":{"S":"METADATA"},"entityType":{"S":"initiatives"},"entityId":{"S":"seed-iac-templates-initiative"},"status":{"S":"published"},"createdAt":{"S":"${NOW}"},"updatedAt":{"S":"${NOW}"},"title":{"S":"Compliant Infrastructure-as-Code Templates"},"description":{"S":"A library of Infrastructure-as-Code templates with pre-configured hardening and compliance checks, so other teams can spin up compliant infrastructure without redoing that work themselves."},"techStack":{"S":"AWS SAM, CloudFormation"},"leadUserId":{"S":"${SEED_USER_SUB}"},"linkedProblemId":{"S":"seed-iac-templates-problem"},"creatorId":{"S":"${SEED_USER_SUB}"},"creatorUsername":{"S":"${SEED_USER_EMAIL}"}}
JSON
)" "INITIATIVE#seed-iac-templates-initiative"
    seed_item "$RELATIONSHIPS_TABLE" "$(cat <<JSON
{"pk":{"S":"ENTITY#initiatives#seed-iac-templates-initiative"},"sk":{"S":"REL#problems#seed-iac-templates-problem"},"relationType":{"S":"addresses"},"sourceType":{"S":"initiatives"},"sourceId":{"S":"seed-iac-templates-initiative"},"relatedType":{"S":"problems"},"relatedId":{"S":"seed-iac-templates-problem"},"createdAt":{"S":"${NOW}"}}
JSON
)" "REL seed-iac-templates-initiative->problem"

    # Theme 4: Chatbot for procurement of new contracts and management of existing contracts
    seed_item "$PROBLEMS_TABLE" "$(cat <<JSON
{"pk":{"S":"PROBLEM#seed-procurement-chatbot-problem"},"sk":{"S":"METADATA"},"entityType":{"S":"problems"},"entityId":{"S":"seed-procurement-chatbot-problem"},"status":{"S":"published"},"createdAt":{"S":"${NOW}"},"updatedAt":{"S":"${NOW}"},"title":{"S":"Teams struggle to manage their own procurement contracts"},"description":{"S":"Many teams have their own procurement contracts to source and manage but are often not very well-versed in procurement management, slowing down new contracts and contract renewals."},"tags":{"L":[{"S":"procurement"},{"S":"contracts"},{"S":"chatbot"}]},"creatorId":{"S":"${SEED_USER_SUB}"},"creatorUsername":{"S":"${SEED_USER_EMAIL}"}}
JSON
)" "PROBLEM#seed-procurement-chatbot-problem"
    seed_item "$INITIATIVES_TABLE" "$(cat <<JSON
{"pk":{"S":"INITIATIVE#seed-procurement-chatbot-initiative"},"sk":{"S":"METADATA"},"entityType":{"S":"initiatives"},"entityId":{"S":"seed-procurement-chatbot-initiative"},"status":{"S":"published"},"createdAt":{"S":"${NOW}"},"updatedAt":{"S":"${NOW}"},"title":{"S":"Procurement Contract Assistant Chatbot"},"description":{"S":"A chatbot that helps teams draft new procurement contracts and manage existing ones, so teams without deep procurement expertise can move faster with fewer mistakes."},"techStack":{"S":"Bedrock, Lambda, API Gateway"},"leadUserId":{"S":"${SEED_USER_SUB}"},"linkedProblemId":{"S":"seed-procurement-chatbot-problem"},"creatorId":{"S":"${SEED_USER_SUB}"},"creatorUsername":{"S":"${SEED_USER_EMAIL}"}}
JSON
)" "INITIATIVE#seed-procurement-chatbot-initiative"
    seed_item "$RELATIONSHIPS_TABLE" "$(cat <<JSON
{"pk":{"S":"ENTITY#initiatives#seed-procurement-chatbot-initiative"},"sk":{"S":"REL#problems#seed-procurement-chatbot-problem"},"relationType":{"S":"addresses"},"sourceType":{"S":"initiatives"},"sourceId":{"S":"seed-procurement-chatbot-initiative"},"relatedType":{"S":"problems"},"relatedId":{"S":"seed-procurement-chatbot-problem"},"createdAt":{"S":"${NOW}"}}
JSON
)" "REL seed-procurement-chatbot-initiative->problem"
  else
    log "WARNING: could not resolve Cognito sub for ${SEED_USER_EMAIL}; skipping mock data seed"
  fi
else
  log "WARNING: UserPoolId output missing; skipping mock data seed"
fi

# ---------------------------------------------------------------------------
# 6. config.js, SPA upload, CloudFront invalidation, outputs.json
# ---------------------------------------------------------------------------
log "Generating frontend/config.js"
cat > frontend/config.js <<EOF
// Generated by deploy.sh - do not edit or commit.
window.APP_CONFIG = {
  apiUrl: "${API_URL}",
  region: "${REGION}",
  userPoolId: "${USER_POOL_ID}",
  userPoolClientId: "${USER_POOL_CLIENT_ID}",
  cognitoDomain: "${COGNITO_DOMAIN}",
  passwordPolicy: { minLength: 8, requireUppercase: true, requireLowercase: true, requireNumbers: true, requireSymbols: true }
};
EOF

if [ -n "$SPA_BUCKET" ]; then
  log "Uploading SPA to s3://${SPA_BUCKET}"
  aws s3 sync frontend/ "s3://${SPA_BUCKET}/" --delete --region "$REGION"
fi

if [ -n "$DISTRIBUTION_ID" ]; then
  log "Invalidating CloudFront distribution ${DISTRIBUTION_ID}"
  aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths '/*' >/dev/null || true
fi

log "Writing outputs.json"
jq -n \
  --arg app_url "$APP_URL" \
  --arg api_url "$API_URL" \
  --arg webhook_api_url "$WEBHOOK_API_URL" \
  --arg user_pool_id "$USER_POOL_ID" \
  --arg user_pool_client_id "$USER_POOL_CLIENT_ID" \
  --arg cognito_domain "$COGNITO_DOMAIN" \
  --arg spa_bucket "$SPA_BUCKET" \
  --arg distribution_id "$DISTRIBUTION_ID" \
  --arg region "$REGION" \
  '{app_url:$app_url, api_url:$api_url, webhook_api_url:$webhook_api_url, user_pool_id:$user_pool_id, user_pool_client_id:$user_pool_client_id, cognito_domain:$cognito_domain, spa_bucket:$spa_bucket, distribution_id:$distribution_id, region:$region}' \
  > outputs.json

log "Done. app_url = ${APP_URL}"
