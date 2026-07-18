#!/bin/bash
# Run once after terraform apply to create the Grafana K8s secret
set -e

PASSWORD=$(aws secretsmanager get-secret-value \
  --secret-id onboarding/grafana-admin \
  --query 'SecretString' --output text | jq -r '.password')

kubectl create secret generic grafana-secret \
  --from-literal=admin-password="$PASSWORD" \
  -n monitoring \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Grafana secret created in monitoring namespace"
