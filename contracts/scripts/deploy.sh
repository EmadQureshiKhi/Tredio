#!/usr/bin/env bash
# Deploys the Tredio contracts to NEAR testnet or mainnet and writes deployments/<network>.json.
# Idempotent: existing accounts are kept, initialized contracts are not re-initialized, published
# global code is not published again.
#
#   ORACLE_PUBLIC_KEY=ed25519:... scripts/deploy.sh testnet
#   ORACLE_PUBLIC_KEY=ed25519:... scripts/deploy.sh mainnet    # #mainnet: spends real NEAR; read MAINNET.md
#   UPGRADE=1 scripts/deploy.sh testnet                        # also redeploy contracts whose code changed
#   BUILD=<commit> UPGRADE=1 scripts/deploy.sh testnet         # the same, from a reproducible build of <commit>
#   PUBLISH_ACCOUNT_CODE=1 scripts/deploy.sh testnet           # publish the built account code as the next version
#
# Ids and parameters come from deployments/<network>.json (mainnet's is the plan until this script
# runs); ROOT, TREASURY, EXCHANGE, SIGNER and RPC override them. On testnet the test USDC token is
# deployed under the root; on mainnet USDC is Circle's native token and nothing is minted.
# Needs near-cli-rs, jq, the built wasm and the signer keys in the legacy keychain
# (~/.near-credentials/<network>). The wasm is the local build (scripts/build.sh), or with BUILD=<commit>
# the reproducible build of that commit (scripts/build.sh --reproducible <commit>); mainnet takes only
# the reproducible build of HEAD.
set -euo pipefail
shopt -s inherit_errexit
cd "$(dirname "$0")/.."

NET=${1:?usage: scripts/deploy.sh testnet|mainnet}
OUT=../deployments/$NET.json
[ "$NET" = mainnet ] && BUILD=$(git rev-parse HEAD)
if [ -n "${BUILD:-}" ]; then BUILD=$(git rev-parse "$BUILD^{commit}") W=target/near-reproducible/$BUILD; else W=target/near; fi
die() { echo "$*" >&2; exit 1; }
planned() { [ -f "$OUT" ] && jq -r "$1 // empty" "$OUT" || true; }

case "$NET" in
  testnet)
    ROOT=${ROOT:-$(planned .root)} ROOT=${ROOT:-tredio.testnet}
    TREASURY=${TREASURY:-$(planned .treasury)} TREASURY=${TREASURY:-tredio-treasury.testnet}
    EXCHANGE=${EXCHANGE:-ref-finance-101.testnet}
    SIGNER=${SIGNER:-v1.signer-prod.testnet}
    RPC=${RPC:-https://test.rpc.fastnear.com}
    FAUCET=${FAUCET:-tredio-faucet.testnet}
    TEST_WINDOW=900
    ;;
  mainnet) # #mainnet
    ROOT=${ROOT:-$(planned .root)}
    TREASURY=${TREASURY:-$(planned .treasury)}
    EXCHANGE=${EXCHANGE:-$(planned .external.exchange)}
    SIGNER=${SIGNER:-$(planned .external.chainSignatures)}
    RPC=${RPC:-https://rpc.mainnet.fastnear.com}
    TEST_WINDOW=0
    ;;
  *) die "network must be testnet or mainnet" ;;
esac
ORACLE_PUBLIC_KEY=${ORACLE_PUBLIC_KEY:?set ORACLE_PUBLIC_KEY to the oracle signing key}
MAINNET_USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
TAKER_FEE_BPS=$(planned .params.bookTakerFeeBps) TAKER_FEE_BPS=${TAKER_FEE_BPS:-20}
MAX_OI=$(planned .params.maxOpenInterestPerSide) MAX_OI=${MAX_OI:-250000000000}
VIRTUAL_QUOTE=$(planned .params.curveBaseVirtualQuote) VIRTUAL_QUOTE=${VIRTUAL_QUOTE:-2000000000}
GRAD_RESERVE=$(planned .params.curveGraduationReserve) GRAD_RESERVE=${GRAD_RESERVE:-2000000000}

log() { printf '\n== %s\n' "$*"; }

# An answer is the node's result or its error about the request (unknown account, a contract that
# panicked). A rate limit (FastNEAR answers HTTP 200 with code -429) or an outage is retried, then
# stops the deploy: a guessed answer could skip a step or repeat one. FASTNEAR_API_KEY lifts the limit.
rpc() { # method params
  local out i
  for i in 1 2 3 4 5 6; do
    out=$(curl -s -m 30 "$RPC" -H 'content-type: application/json' ${FASTNEAR_API_KEY:+-H "authorization: Bearer $FASTNEAR_API_KEY"} \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}") || out=""
    if jq -e 'has("result") or (has("error") and .error.code != -429 and (.error.cause.name // "") != "TOO_MANY_REQUESTS")' >/dev/null 2>&1 <<<"$out"; then
      printf '%s' "$out"
      return
    fi
    sleep $((i * 3))
  done
  die "$RPC kept failing on $1 $2"
}
account() { rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}"; }
exists() { local a; a=$(account "$1"); jq -e '.result.amount' >/dev/null <<<"$a"; }
code_hash() { local a; a=$(account "$1"); jq -r '.result.code_hash // empty' <<<"$a"; }
has_code() { local h; h=$(code_hash "$1"); [ -n "$h" ] && [ "$h" != 11111111111111111111111111111111 ]; }
view() { # account method args: the view's JSON answer, or nothing when the contract refused (not initialized, no such method)
  local out
  out=$(rpc query "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf '%s' "${3:-{\}}" | base64)\"}")
  jq -c '.result.result // empty | implode | fromjson' <<<"$out" 2>/dev/null || true
}
initialized() { local v; v=$(view "$1" "$2"); [ -n "$v" ]; }
global_published() {
  local out
  out=$(rpc query "{\"request_type\":\"view_global_contract_code\",\"finality\":\"final\",\"code_hash\":\"$1\"}")
  jq -e '.result.code_base64' >/dev/null 2>&1 <<<"$out"
}

call() { # receiver method json [deposit] [gas] [signer]
  near contract call-function as-transaction "$1" "$2" json-args "$3" \
    prepaid-gas "${5:-100.0 Tgas}" attached-deposit "${4:-0 NEAR}" \
    sign-as "${6:-$ROOT}" network-config "$NET" sign-with-legacy-keychain send >/dev/null
}

sub() { # name balance
  local id="$1.$ROOT"
  if exists "$id"; then echo "account $id exists"; return; fi
  near account create-account fund-myself "$id" "$2" autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$ROOT" network-config "$NET" sign-with-legacy-keychain send >/dev/null
  echo "created $id"
}

hash_of() { # wasm file: base58 sha256, NEAR's code hash
  python3 -c "import hashlib,sys;d=hashlib.sha256(open(sys.argv[1],'rb').read()).digest();A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';n=int.from_bytes(d,'big');s=''
while n: n,r=divmod(n,58); s=A[r]+s
print(s)" "$1"
}
wasm() { if [ -n "${BUILD:-}" ]; then echo "$W/tredio_$1.wasm"; else echo "$W/tredio_$1/tredio_$1.wasm"; fi; }

deploy() { # name crate init-json probe-method
  local id="$1.$ROOT" file
  file=$(wasm "$2")
  if has_code "$id" && initialized "$id" "$4"; then
    if [ -n "${UPGRADE:-}" ] && [ "$(code_hash "$id")" != "$(hash_of "$file")" ]; then
      # Code only: the new code must read the state the old one wrote (migrations are separate).
      near contract deploy "$id" use-file "$file" without-init-call network-config "$NET" sign-with-legacy-keychain send >/dev/null
      echo "upgraded $id to $(hash_of "$file")"
    else
      echo "$id already deployed"
    fi
    return
  fi
  near contract deploy "$id" use-file "$file" with-init-call new json-args "$3" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config "$NET" sign-with-legacy-keychain send >/dev/null
  echo "deployed tredio_$2 to $id"
}

publish() { # crate
  local h
  h=$(hash_of "$(wasm "$1")")
  if global_published "$h"; then echo "global code $1 $h already published"; return; fi
  log "publish $1 as global code $h"
  near contract deploy-as-global use-file "$(wasm "$1")" as-global-hash "$ROOT" \
    network-config "$NET" sign-with-legacy-keychain send >/dev/null
}

CRATES=(registry outcomes book perps curation coin coins account accounts)
[ "$NET" = testnet ] && CRATES=(usdc "${CRATES[@]}")
for c in "${CRATES[@]}"; do [ -f "$(wasm "$c")" ] || die "missing $(wasm "$c"): run scripts/build.sh${BUILD:+ --reproducible $BUILD} first"; done
if [ -n "${BUILD:-}" ]; then
  repo=$(sed -n 's/^repository = "\(.*\)"$/\1/p' Cargo.toml)
  for c in "${CRATES[@]}"; do
    grep -aq "git+$repo?rev=$BUILD" "$(wasm "$c")" || die "$(wasm "$c") does not record $repo at $BUILD"
  done
fi

if [ "$NET" = mainnet ]; then
  # #mainnet: everything below spends real NEAR from $ROOT, so it runs only on code anyone can verify.
  [ -n "$ROOT" ] && [ -n "$TREASURY" ] && [ -n "$EXCHANGE" ] && [ -n "$SIGNER" ] || die "deployments/mainnet.json must name root, treasury, exchange and chainSignatures"
  [ "$(planned .contracts.usdc)" = "$MAINNET_USDC" ] || die "deployments/mainnet.json must name native USDC ($MAINNET_USDC)"
  [ -z "$(git status --porcelain)" ] || die "commit everything first: mainnet deploys the reproducible build of HEAD"
  head=$BUILD
  [ "$ORACLE_PUBLIC_KEY" != "$(jq -r .oracle.publicKey ../deployments/testnet.json)" ] || die "use a mainnet oracle key: the testnet one signs testnet reports"
  exists "$ROOT" || die "$ROOT does not exist on mainnet: create and fund it first"
  echo "About to deploy Tredio $head to NEAR mainnet under $ROOT (treasury $TREASURY, oracle $ORACLE_PUBLIC_KEY)."
  if [ "${CONFIRM:-}" != "deploy to mainnet" ]; then
    read -r -p "Type 'deploy to mainnet' to continue: " answer
    [ "$answer" = "deploy to mainnet" ] || die "stopped"
  fi
fi

START_BLOCK=$(planned .startBlock)
if [ -z "$START_BLOCK" ] && ! exists "registry.$ROOT"; then
  # The indexer starts here: nothing Tredio logged an event before its first contract account.
  block=$(rpc block '{"finality":"final"}')
  START_BLOCK=$(jq -r .result.header.height <<<"$block")
fi

log "accounts"
# Code storage (1 NEAR per 100 KB) plus room for state.
[ "$NET" = testnet ] && sub usdc '2.1 NEAR'
sub registry '2.7 NEAR'
sub outcomes '3.1 NEAR'
sub book '3.2 NEAR'
sub perps '2.9 NEAR'
sub curation '1.8 NEAR'
sub coins '3.5 NEAR'
sub accounts '1.9 NEAR'

# Global code is published once per version: about 10 NEAR per 100 KB, burned, and each build's bytes
# differ. A live deployment keeps the code its factories already use; PUBLISH_ACCOUNT_CODE=1 publishes
# the built account code as the version accounts upgrade to (globalCode.accountV2).
BUILT_ACCOUNT_CODE=$(hash_of "$(wasm account)")
if initialized "coins.$ROOT" protocol_fees; then
  COIN_CODE=$(planned .globalCode.coin)
  [ -n "$COIN_CODE" ] || die "coins.$ROOT is live but deployments/$NET.json names no coin code"
else
  publish coin
  COIN_CODE=$(hash_of "$(wasm coin)")
fi
if initialized "accounts.$ROOT" config; then
  [ -z "${PUBLISH_ACCOUNT_CODE:-}" ] || publish account
else
  publish account
fi

if [ "$NET" = testnet ]; then U=usdc.$ROOT; else U=$MAINNET_USDC; fi
R=registry.$ROOT O=outcomes.$ROOT B=book.$ROOT P=perps.$ROOT C=curation.$ROOT K=coins.$ROOT A=accounts.$ROOT

log "contracts"
[ "$NET" = testnet ] && deploy usdc usdc "{\"owner\":\"$ROOT\",\"drip_amount\":\"1000000000\",\"drip_cooldown\":3600}" ft_metadata
deploy registry registry "{\"owner\":\"$ROOT\",\"oracle\":{\"tee_signer\":{\"public_key\":\"$ORACLE_PUBLIC_KEY\"}},\"params\":{\"staleness_limit\":900,\"max_move_bps\":5000,\"attention_floor\":5000000,\"cooling_window\":3600,\"retire_window\":7200,\"stale_retire_window\":21600,\"settlement_tolerance\":900,\"max_report_age\":600,\"max_future_skew\":60}}" get_params
deploy outcomes outcomes "{\"owner\":\"$ROOT\",\"usdc\":\"$U\",\"registry\":\"$R\",\"test_window\":$TEST_WINDOW}" windows
deploy book book "{\"owner\":\"$ROOT\",\"usdc\":\"$U\",\"outcomes\":\"$O\",\"registry\":\"$R\",\"treasury\":\"$TREASURY\",\"taker_fee_bps\":$TAKER_FEE_BPS}" taker_fee_bps
deploy curation curation "{\"owner\":\"$ROOT\",\"usdc\":\"$U\",\"treasury\":\"$TREASURY\"}" totals
deploy perps perps "{\"owner\":\"$ROOT\",\"usdc\":\"$U\",\"registry\":\"$R\",\"curation\":\"$C\",\"treasury\":\"$TREASURY\",\"max_oi_per_side\":\"$MAX_OI\"}" pool
deploy coins coins "{\"owner\":\"$ROOT\",\"usdc\":\"$U\",\"registry\":\"$R\",\"curation\":\"$C\",\"treasury\":\"$TREASURY\",\"exchange\":\"$EXCHANGE\",\"pool_fee_bps\":30,\"coin_code\":\"$COIN_CODE\",\"base_virtual_quote\":\"$VIRTUAL_QUOTE\",\"graduation_reserve\":\"$GRAD_RESERVE\"}" protocol_fees
PROTOCOL="{\"usdc\":\"$U\",\"registry\":\"$R\",\"outcomes\":\"$O\",\"book\":\"$B\",\"perps\":\"$P\",\"coins\":\"$K\",\"curation\":\"$C\",\"signer\":\"$SIGNER\",\"factory\":\"$A\"}"
deploy accounts accounts "{\"owner\":\"$ROOT\",\"network\":\"$NET\",\"protocol\":$PROTOCOL,\"account_code\":\"$BUILT_ACCOUNT_CODE\"}" config

log "wiring"
# Every wiring call is idempotent.
call "$R" add_consumer "{\"account_id\":\"$O\"}"
call "$C" add_source "{\"account_id\":\"$P\"}"
call "$C" add_source "{\"account_id\":\"$K\"}"
[ "$NET" = testnet ] && call "$U" add_minter "{\"account_id\":\"$FAUCET\"}"
for holder in "$O" "$B" "$P" "$C" "$K" "$TREASURY" "$EXCHANGE"; do
  registered=$(view "$U" storage_balance_of "{\"account_id\":\"$holder\"}")
  [ "$registered" = null ] || { echo "$holder holds USDC storage"; continue; }
  call "$U" storage_deposit "{\"account_id\":\"$holder\",\"registration_only\":true}" '0.00125 NEAR'
done
call "$B" storage_deposit "{\"account_id\":\"$TREASURY\"}" '0.05 NEAR'
# The book holds outcome tokens for its traders: one balance per account and token.
call "$O" storage_deposit "{\"account_id\":\"$B\"}" '1 NEAR'
# The coin factory registers with the exchange once; the exchange's own record says whether it did.
prepared=$(view "$EXCHANGE" storage_balance_of "{\"account_id\":\"$K\"}")
if [ "$prepared" = null ]; then call "$K" prepare_exchange '{}' '0.11 NEAR' '150.0 Tgas'; else echo "$K is registered with $EXCHANGE"; fi

# Accounts are born on the factory's code; code built since then is the version they upgrade to.
config=$(view "$A" config)
FACTORY_CODE=$(jq -r '.[2]' <<<"$config")
[ -n "$FACTORY_CODE" ] && [ "$FACTORY_CODE" != null ] || die "could not read the accounts factory's code"
ACCOUNT_V2=$(planned .globalCode.accountV2)
[ -z "${PUBLISH_ACCOUNT_CODE:-}" ] || [ "$BUILT_ACCOUNT_CODE" = "$FACTORY_CODE" ] || ACCOUNT_V2=$BUILT_ACCOUNT_CODE

log "deployments/$NET.json"
mkdir -p ../deployments
jq -n \
  --arg network "$NET" --arg root "$ROOT" --arg treasury "$TREASURY" \
  --arg usdc "$U" --arg registry "$R" --arg outcomes "$O" --arg book "$B" --arg perps "$P" \
  --arg curation "$C" --arg coins "$K" --arg accounts "$A" --arg exchange "$EXCHANGE" --arg signer "$SIGNER" \
  --arg coin_code "$COIN_CODE" --arg account_code "$FACTORY_CODE" --arg account_v2 "$ACCOUNT_V2" --arg oracle_key "$ORACLE_PUBLIC_KEY" \
  --arg rpc "$RPC" --arg deployed_at "$(planned .deployedAt)" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg start_block "$START_BLOCK" \
  --argjson test_window "$TEST_WINDOW" --argjson taker_fee "$TAKER_FEE_BPS" --arg max_oi "$MAX_OI" --arg virtual_quote "$VIRTUAL_QUOTE" --arg grad_reserve "$GRAD_RESERVE" \
  '{network:$network, rpc:$rpc, deployedAt:(if $deployed_at == "" then $now else $deployed_at end), root:$root, treasury:$treasury}
    + (if $start_block == "" then {} else {startBlock:($start_block|tonumber)} end)
    + {contracts:{usdc:$usdc, registry:$registry, outcomes:$outcomes, book:$book, perps:$perps, curation:$curation, coins:$coins, accounts:$accounts},
    external:{exchange:$exchange, chainSignatures:$signer},
    globalCode:({coin:$coin_code, account:$account_code} + (if $account_v2 == "" then {} else {accountV2:$account_v2} end)),
    oracle:{mode:"tee_signer", publicKey:$oracle_key},
    params:{usdcDecimals:6, indexDecimals:6, coinDecimals:18, outcomeTestWindow:$test_window, bookTakerFeeBps:$taker_fee, maxOpenInterestPerSide:$max_oi, curveBaseVirtualQuote:$virtual_quote, curveGraduationReserve:$grad_reserve}}' >"$OUT.tmp"
mv "$OUT.tmp" "$OUT"
cat "$OUT"
