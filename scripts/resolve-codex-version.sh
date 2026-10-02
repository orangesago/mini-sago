#!/usr/bin/env bash
set -euo pipefail

curl --fail --silent --show-error --retry 3 --connect-timeout 10 --max-time 30 \
  https://registry.npmjs.org/@openai/codex/latest \
  | jq -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))'
