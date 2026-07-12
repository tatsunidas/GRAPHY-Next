#!/usr/bin/env bash
#
# One-time helper: create the GRAPHY support-subscription product + billing plan
# in PayPal and print the plan id (P-XXXXXXXXXXXX) to paste into
# src/data/site.ts (site.payment.paypalPlanId).
#
# Credentials are read from the environment — never hardcode or commit the
# secret. The client-id is safe to publish (it ships in the browser SDK URL);
# the secret is used only here, server-side, to mint an OAuth token.
#
#   export PAYPAL_CLIENT_ID=...        # LIVE (or sandbox) REST app client id
#   export PAYPAL_SECRET=...           # matching secret
#   export PAYPAL_ENV=live             # 'live' (default) or 'sandbox'
#   bash scripts/paypal-create-plan.sh
#
# JPY is a zero-decimal currency, so the price is "700" (not "700.00").
#
set -euo pipefail

: "${PAYPAL_CLIENT_ID:?set PAYPAL_CLIENT_ID}"
: "${PAYPAL_SECRET:?set PAYPAL_SECRET}"
ENV="${PAYPAL_ENV:-live}"

case "$ENV" in
  live)    API="https://api-m.paypal.com" ;;
  sandbox) API="https://api-m.sandbox.paypal.com" ;;
  *) echo "PAYPAL_ENV must be 'live' or 'sandbox'" >&2; exit 1 ;;
esac

PRICE_VALUE="${PRICE_VALUE:-700}"
CURRENCY="${CURRENCY:-JPY}"
PRODUCT_NAME="${PRODUCT_NAME:-GRAPHY Support Subscription}"
PLAN_NAME="${PLAN_NAME:-GRAPHY Support ¥${PRICE_VALUE}/month}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "[1/3] OAuth token ($ENV)..."
TOKEN="$(curl -fsS -u "$PAYPAL_CLIENT_ID:$PAYPAL_SECRET" \
  "$API/v1/oauth2/token" \
  -H 'Accept: application/json' \
  -d 'grant_type=client_credentials' | jq -r '.access_token')"
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { echo "failed to get token (check credentials / env)" >&2; exit 1; }
echo "  ok"

say "[2/3] Create product..."
PRODUCT_ID="$(curl -fsS -X POST "$API/v1/catalogs/products" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg name "$PRODUCT_NAME" '{
        name: $name,
        description: "Technical support and update notifications for GRAPHY-Next",
        type: "SERVICE",
        category: "SOFTWARE",
        home_url: "https://graphy.vis-ionary.com/support"
      }')" | jq -r '.id')"
[[ -n "$PRODUCT_ID" && "$PRODUCT_ID" != "null" ]] || { echo "product creation failed" >&2; exit 1; }
echo "  product_id: $PRODUCT_ID"

say "[3/3] Create billing plan (${CURRENCY} ${PRICE_VALUE}/month)..."
PLAN_JSON="$(curl -fsS -X POST "$API/v1/billing/plans" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
  -d "$(jq -n \
        --arg product_id "$PRODUCT_ID" \
        --arg name "$PLAN_NAME" \
        --arg value "$PRICE_VALUE" \
        --arg currency "$CURRENCY" '{
        product_id: $product_id,
        name: $name,
        description: "Monthly support subscription for GRAPHY-Next",
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: { interval_unit: "MONTH", interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: { fixed_price: { value: $value, currency_code: $currency } }
          }
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee: { value: "0", currency_code: $currency },
          setup_fee_failure_action: "CONTINUE",
          payment_failure_threshold: 3
        }
      }')")"
PLAN_ID="$(echo "$PLAN_JSON" | jq -r '.id')"
PLAN_STATUS="$(echo "$PLAN_JSON" | jq -r '.status')"
[[ -n "$PLAN_ID" && "$PLAN_ID" != "null" ]] || { echo "plan creation failed:"; echo "$PLAN_JSON" >&2; exit 1; }

say "DONE"
echo "  env:      $ENV"
echo "  plan_id:  $PLAN_ID  (status: $PLAN_STATUS)"
echo
echo "Next: put these into src/data/site.ts -> site.payment:"
echo "  paypalClientId: '$PAYPAL_CLIENT_ID',"
echo "  paypalPlanId:   '$PLAN_ID',"
