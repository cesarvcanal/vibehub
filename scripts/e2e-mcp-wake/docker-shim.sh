#!/bin/bash
# E2E shim: `docker exec [-i] <container> cmd...` runs cmd HERE (this container is the runner).
# The SDK dir is redirected to an isolated copy so the production runner's planted driver is untouched.
[ "$1" = exec ] || { echo "shim: only exec" >&2; exit 2; }
shift; [ "$1" = -i ] && shift; shift
args=()
for a in "$@"; do args+=("${a//\/root\/.vibehub-sdk/$E2E_SDK}"); done
if [ "${args[-1]}" = "-s" ] && [ "${args[-2]}" = "bash" ]; then
  sed -u "s#/root/.vibehub-sdk#$E2E_SDK#g" | exec "${args[@]}"
fi
exec "${args[@]}"
