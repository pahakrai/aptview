#!/bin/bash
# ============================================================================
# generate-sso-keys.sh — Generate RSA key pair for SSO JWT signing
# ============================================================================
# Generates a 2048-bit RSA private key and extracts the public key.
# The private key is stored as a K8s secret. The public key is mounted
# to the Nginx gateway pod for JWT verification.
#
# Usage:
#   chmod +x scripts/generate-sso-keys.sh
#   ./scripts/generate-sso-keys.sh
# ============================================================================

set -e

echo "Generating RSA 2048-bit key pair for SSO..."

# Generate private key
openssl genrsa -out sso_private.pem 2048

# Extract public key
openssl rsa -pubout -in sso_private.pem -out sso_public_key.pem

echo ""
echo "Keys generated:"
echo "  Private: sso_private.pem"
echo "  Public:  sso_public_key.pem"
echo ""

# Create K8s secrets
echo "Creating K8s secrets..."

# Private key secret (for NestJS backend)
kubectl create secret generic sso-private-key \
  --from-file=sso_private.pem=sso_private.pem \
  -n aigov \
  --dry-run=client -o yaml | kubectl apply -f -

# Public key secret (for Nginx gateway)
kubectl create secret generic sso-public-key \
  --from-file=sso_public_key.pem=sso_public_key.pem \
  -n aigov \
  --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "Secrets created in namespace 'aigov':"
echo "  sso-private-key (for backend)"
echo "  sso-public-key  (for nginx)"
echo ""
echo "Next steps:"
echo "  1. Set SSO_PRIVATE_KEY_PATH=/secrets/sso/sso_private.pem in backend deployment"
echo "  2. Restart backend: kubectl rollout restart deploy/backend -n aigov"
echo "  3. Restart nginx:   kubectl rollout restart deploy/nginx-sso -n aigov"
echo ""
echo "⚠️  Keep sso_private.pem secure. Do not commit to version control."
