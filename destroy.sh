#!/usr/bin/env bash
#
# destroy.sh - tear down everything deploy.sh created. Idempotent; exits
# non-zero only on an unrecoverable stack-deletion failure.
#
# S3 buckets must be emptied before CloudFormation can delete them. The S3
# Vectors bucket/indexes and the artifacts bucket are NOT CloudFormation
# resources (created directly by deploy.sh), so they are removed directly here.

set -euo pipefail

REGION="ap-southeast-1"
PREFIX="app-193a359c-027ffd1c-"
STACK="${PREFIX}portal"
ARTIFACTS_BUCKET="${PREFIX}artifacts"
VECTOR_BUCKET="${PREFIX}vectors"
ENTITIES="problems initiatives solutions findings assets sme-profiles"
STACK_BUCKETS="${PREFIX}spa-assets ${PREFIX}ingestion-staging ${PREFIX}assets ${PREFIX}dashboard-snapshots"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

log() { echo "[destroy] $*"; }

empty_bucket() {
  local b="$1"
  if aws s3api head-bucket --bucket "$b" 2>/dev/null; then
    log "Emptying s3://${b}"
    aws s3 rm "s3://${b}" --recursive --region "$REGION" || true
  fi
}

# 1. Empty the CloudFormation-managed buckets so DeleteStack can remove them.
for b in $STACK_BUCKETS; do empty_bucket "$b"; done

# 2. Delete the stack and wait for completion.
if aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
  log "Deleting stack ${STACK}"
  aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION"
  log "Waiting for stack deletion"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION"
else
  log "Stack ${STACK} not found; skipping"
fi

# 3. Delete S3 Vectors indexes + bucket (never owned by CloudFormation).
for ENTITY in $ENTITIES; do
  aws s3vectors delete-index --vector-bucket-name "$VECTOR_BUCKET" --index-name "$ENTITY" --region "$REGION" >/dev/null 2>&1 || true
done
aws s3vectors delete-vector-bucket --vector-bucket-name "$VECTOR_BUCKET" --region "$REGION" >/dev/null 2>&1 || true

# 4. Delete the artifacts bucket (never owned by CloudFormation).
empty_bucket "$ARTIFACTS_BUCKET"
aws s3api delete-bucket --bucket "$ARTIFACTS_BUCKET" --region "$REGION" >/dev/null 2>&1 || true

# 5. Local generated files.
rm -f outputs.json frontend/config.js

log "Teardown complete"
