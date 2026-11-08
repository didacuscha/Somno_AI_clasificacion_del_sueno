#!/usr/bin/env bash
# Presupuesto mensual de la cuenta con avisos por correo:
#
#   deploy/aws/presupuesto.sh <correo> [tope en USD]      (tope por defecto: 10)
#
# Avisa al llegar al 50 % y al 100 % del tope, y cuando el pronóstico del mes lo supera.
# Cuenta el gasto ANTES de créditos: con créditos promocionales el gasto neto es 0 y un
# presupuesto normal nunca avisaría.
set -euo pipefail
EMAIL=${1:?uso: deploy/aws/presupuesto.sh <correo> [tope en USD]}
LIMIT=${2:-10}
NAME=somnoai-mensual
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

budget=$(cat <<EOF
{"BudgetName": "$NAME", "BudgetType": "COST", "TimeUnit": "MONTHLY",
 "BudgetLimit": {"Amount": "$LIMIT", "Unit": "USD"},
 "CostTypes": {"IncludeCredit": false, "IncludeRefund": false, "IncludeTax": true,
               "IncludeSubscription": true, "IncludeRecurring": true, "IncludeUpfront": true,
               "IncludeOtherSubscription": true, "IncludeSupport": true, "IncludeDiscount": true,
               "UseBlended": false, "UseAmortized": false}}
EOF
)
alert() {  # tipo (ACTUAL|FORECASTED), porcentaje
  printf '{"Notification": {"NotificationType": "%s", "ComparisonOperator": "GREATER_THAN", "Threshold": %s, "ThresholdType": "PERCENTAGE"}, "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "%s"}]}' "$1" "$2" "$EMAIL"
}
notifications="[$(alert ACTUAL 50), $(alert ACTUAL 100), $(alert FORECASTED 100)]"

if aws budgets describe-budget --account-id "$ACCOUNT" --budget-name "$NAME" >/dev/null 2>&1; then
  echo "el presupuesto $NAME ya existe: se actualiza el tope a $LIMIT USD (los avisos se conservan)"
  aws budgets update-budget --account-id "$ACCOUNT" --new-budget "$budget"
else
  aws budgets create-budget --account-id "$ACCOUNT" --budget "$budget" --notifications-with-subscribers "$notifications"
  echo "presupuesto $NAME: $LIMIT USD/mes · avisos a $EMAIL al 50 % y 100 % del gasto, y si el pronóstico lo supera"
fi
