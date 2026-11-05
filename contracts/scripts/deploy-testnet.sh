#!/usr/bin/env bash
# Deploys the Tredio contracts to NEAR testnet under $ROOT and writes deployments/testnet.json.
# Idempotent: existing accounts are kept, initialized contracts are not re-initialized.
# Needs near-cli-rs, jq, the built wasm (scripts/build.sh) and the signer keys in the legacy
# keychain (~/.near-credentials/testnet).
#
#   ROOT=tredio.testnet ORACLE_PUBLIC_KEY=ed25519:... scripts/deploy-testnet.sh
set -euo pipefail
cd "$(dirname "$0")/.."

NET=testnet
ROOT=${ROOT:-tredio.testnet}
TREASURY=${TREASURY:-tredio-treasury.testnet}
FAUCET=${FAUCET:-tredio-faucet.testnet}
EXCHANGE=${EXCHANGE:-ref-finance-101.testnet}
SIGNER=${SIGNER:-v1.signer-prod.testnet}
ORACLE_PUBLIC_KEY=${ORACLE_PUBLIC_KEY:?set ORACLE_PUBLIC_KEY to the oracle signing key}
RPC=${RPC:-https://test.rpc.fastnear.com}
W=target/near
OUT=../deployments/testnet.json

log() { printf '\n== %s\n' "$*"; }

exists() {
  curl -s "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    jq -e '.result.amount' >/dev/null
}

has_code() {
  curl -s "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    jq -e '.result.code_hash != "11111111111111111111111111111111"' >/dev/null
}

view() { # account method args
  curl -s "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf '%s' "${3:-{\}}" | base64)\"}}"
}

initialized() { view "$1" "$2" | jq -e '.result.result' >/dev/null; }

call() { # receiver method json [deposit] [gas] [signer]
  near contract call-function as-transaction "$1" "$2" json-args "$3" \
    prepaid-gas "${5:-100.0 Tgas}" attached-deposit "${4:-0 NEAR}" \
    sign-as "${6:-$ROOT}" network-config $NET sign-with-legacy-keychain send >/dev/null
}

sub() { # name balance
  local id="$1.$ROOT"
  if exists "$id"; then echo "account $id exists"; return; fi
  near account create-account fund-myself "$id" "$2" autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$ROOT" network-config $NET sign-with-legacy-keychain send >/dev/null
  echo "created $id"
}

deploy() { # name crate init-json probe-method
  local id="$1.$ROOT"
  if has_code "$id" && initialized "$id" "$4"; then echo "$id already deployed"; return; fi
  near contract deploy "$id" use-file "$W/$2/$2.wasm" with-init-call new json-args "$3" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config $NET sign-with-legacy-keychain send >/dev/null
  echo "deployed $2 to $id"
}

global_hash() { # crate
  python3 -c "import hashlib,sys,base64;d=hashlib.sha256(open(sys.argv[1],'rb').read()).digest();A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';n=int.from_bytes(d,'big');s='';
while n: n,r=divmod(n,58); s=A[r]+s
print(s)" "$W/$1/$1.wasm"
}

publish() { # crate
  log "publish $1 as global code $(global_hash "$1")"
  near contract deploy-as-global use-file "$W/$1/$1.wasm" as-global-hash "$ROOT" \
    network-config $NET sign-with-legacy-keychain send >/dev/null
}

log "accounts"
# Code storage (1 NEAR per 100 KB) plus room for state.
sub usdc '2.1 NEAR'
sub registry '2.7 NEAR'
sub outcomes '3.1 NEAR'
sub book '3.2 NEAR'
sub perps '2.9 NEAR'
sub curation '1.8 NEAR'
sub coins '3.5 NEAR'
sub accounts '1.9 NEAR'

COIN_CODE=$(global_hash tredio_coin)
ACCOUNT_CODE=$(global_hash tredio_account)
publish tredio_coin
publish tredio_account

U=usdc.$ROOT R=registry.$ROOT O=outcomes.$ROOT B=book.$ROOT P=perps.$ROOT C=curation.$ROOT K=coins.$ROOT A=accounts.$ROOT

log "contracts"
deploy usdc tredio_usdc "{\"owner\":\"$ROOT\",\"drip_amount\":\"1000000000\",\"drip_cooldown\":3600}" ft_metadata
deploy registry tredio_registry "{\"owner\":\"$ROOT\",\"oracle\":{\"tee_signer\":{\"public_key\":\"$ORACLE_PUBLIC_KEY\"}},\"params\":{\"staleness_limit\":900,\"max_move_bps\":5000,\"attention_floor\":5000000,\"cooling_window\":3600,\"retire_window\":7200,\"stale_retire_window\":21600,\"settlement_tolerance\":900,\"max_report_age\":600,\"max_future_skew\":60}}" get_params
deploy outcomes tredio_outcomes "{\"owner\":\"$ROOT\",\"usdc\":\"$U\",\"registry\":\"$R\",\"test_window\":900}" windows
deploy book tredio_book "{\"owner\":\"$ROOT\",\"usdc\":\"$U\",\"outcomes\":\"$O\",\"registry\":\"$R\",\"treasury\":\"$TREASURY\",\"taker_fee_bps\":20}" taker_fee_bps
deploy curation tredio_curation "{\"owner\":\"$ROOT\",\"usdc\":\"$U\",\"treasury\":\"$TREASURY\"}" totals
deploy perps tredio_perps "{\"owner\":\"$ROOT\",\"usdc\":\"$U\",\"registry\":\"$R\",\"curation\":\"$C\",\"treasury\":\"$TREASURY\",\"max_oi_per_side\":\"250000000000\"}" pool
deploy coins tredio_coins "{\"owner\":\"$ROOT\",\"usdc\":\"$U\",\"registry\":\"$R\",\"curation\":\"$C\",\"treasury\":\"$TREASURY\",\"exchange\":\"$EXCHANGE\",\"pool_fee_bps\":30,\"coin_code\":\"$COIN_CODE\",\"base_virtual_quote\":\"2000000000\",\"graduation_reserve\":\"2000000000\"}" protocol_fees
PROTOCOL="{\"usdc\":\"$U\",\"registry\":\"$R\",\"outcomes\":\"$O\",\"book\":\"$B\",\"perps\":\"$P\",\"coins\":\"$K\",\"curation\":\"$C\",\"signer\":\"$SIGNER\",\"factory\":\"$A\"}"
deploy accounts tredio_accounts "{\"owner\":\"$ROOT\",\"network\":\"testnet\",\"protocol\":$PROTOCOL,\"account_code\":\"$ACCOUNT_CODE\"}" config

log "wiring"
# Every wiring call is idempotent.
call "$R" add_consumer "{\"account_id\":\"$O\"}"
call "$C" add_source "{\"account_id\":\"$P\"}"
call "$C" add_source "{\"account_id\":\"$K\"}"
call "$U" add_minter "{\"account_id\":\"$FAUCET\"}"
for holder in "$O" "$B" "$P" "$C" "$K" "$TREASURY" "$EXCHANGE"; do
  call "$U" storage_deposit "{\"account_id\":\"$holder\",\"registration_only\":true}" '0.00125 NEAR'
done
call "$B" storage_deposit "{\"account_id\":\"$TREASURY\"}" '0.05 NEAR'
# The book holds outcome tokens for its traders: one balance per account and token.
call "$O" storage_deposit "{\"account_id\":\"$B\"}" '1 NEAR'
[ -f ../deployments/.exchange-prepared ] || { call "$K" prepare_exchange '{}' '0.11 NEAR' '150.0 Tgas' && touch ../deployments/.exchange-prepared; }

log "deployments/testnet.json"
mkdir -p ../deployments
jq -n \
  --arg network testnet --arg root "$ROOT" --arg treasury "$TREASURY" \
  --arg usdc "$U" --arg registry "$R" --arg outcomes "$O" --arg book "$B" --arg perps "$P" \
  --arg curation "$C" --arg coins "$K" --arg accounts "$A" --arg exchange "$EXCHANGE" --arg signer "$SIGNER" \
  --arg coin_code "$COIN_CODE" --arg account_code "$ACCOUNT_CODE" --arg oracle_key "$ORACLE_PUBLIC_KEY" \
  --arg rpc "$RPC" --arg deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{network:$network, rpc:$rpc, deployedAt:$deployed_at, root:$root, treasury:$treasury,
    contracts:{usdc:$usdc, registry:$registry, outcomes:$outcomes, book:$book, perps:$perps, curation:$curation, coins:$coins, accounts:$accounts},
    external:{exchange:$exchange, chainSignatures:$signer},
    globalCode:{coin:$coin_code, account:$account_code},
    oracle:{mode:"tee_signer", publicKey:$oracle_key},
    params:{usdcDecimals:6, indexDecimals:6, coinDecimals:18, outcomeTestWindow:900, bookTakerFeeBps:20, maxOpenInterestPerSide:"250000000000", curveBaseVirtualQuote:"2000000000", curveGraduationReserve:"2000000000"}}' >"$OUT"
cat "$OUT"
