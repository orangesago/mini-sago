#!/bin/sh
set -eu
# Test the stable Codex release used by worker image builds. No login, model call,
# GitHub access, or production mount is used by this smoke test.
codex_version="${CODEX_VERSION:-$(bash scripts/resolve-codex-version.sh)}"
docker build --target runtime -f Dockerfile.worker \
  --build-arg "CODEX_VERSION=$codex_version" -t minisago-dev-runtime:test .
case "$(docker info --format '{{json .SecurityOptions}}')" in
  *apparmor*) apparmor_profile=minisago-worker ;;
  *) apparmor_profile=unconfined ;;
esac
docker run --rm --init --user bun \
  --security-opt "seccomp=$PWD/scripts/test-fixtures/worker-security/minisago-worker.seccomp.json" \
  --security-opt "apparmor=$apparmor_profile" \
  --mount "type=bind,src=$PWD/worker/src,dst=/source/worker/src,readonly" \
  --entrypoint bun minisago-dev-runtime:test /source/worker/src/test-fixtures/dev-sandbox-smoke.ts
