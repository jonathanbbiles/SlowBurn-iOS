#!/usr/bin/env bash
#
# cm-build.sh — start a Codemagic build from the terminal. No browser, no clicking.
#
# Pushing to `main` already auto-starts the TestFlight workflow (see the `triggering:`
# block in codemagic.yaml). This script covers the rest: re-running a build without a
# new commit, building a non-main branch, or firing a build from a script.
#
# Run `scripts/cm-build.sh --help` for usage.
#
# SECRETS: the Codemagic API token is read from $CODEMAGIC_API_TOKEN and nowhere else.
# It is never written to this repo, never printed, and it reaches curl through a config
# file on stdin so it does not appear in `ps` output. Do not pass it as an argument.
#
# Requires: bash, curl 7.76+, python3.

set -euo pipefail

CM_API_BASE="${CM_API_BASE:-https://api.codemagic.io}"
WORKFLOW_ID="${CODEMAGIC_WORKFLOW_ID:-ios-testflight}"
APP_ID="${CODEMAGIC_APP_ID:-}"
BRANCH=""
WATCH=0
LIST_APPS=0
SAVE_APP_ID=0
POLL_SECONDS="${CM_POLL_SECONDS:-20}"

die()  { printf 'cm-build: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

usage() {
  cat <<'EOF'
cm-build.sh — start a Codemagic build without opening a browser.

USAGE
  scripts/cm-build.sh                   build the current branch with the ios-testflight workflow
  scripts/cm-build.sh --watch           ...and poll until the build reaches a terminal state
  scripts/cm-build.sh -b main --watch
  scripts/cm-build.sh -w ios-testflight -a 6172cc7d57278d06d4e915f1
  scripts/cm-build.sh --list-apps       print every app id / name / workflow in your Codemagic team
  scripts/cm-build.sh --save-app-id     resolve the app id once and cache it in .codemagic-app-id

OPTIONS
  -a, --app-id ID     Codemagic application id. Resolution order when omitted:
                        $CODEMAGIC_APP_ID -> ./.codemagic-app-id -> auto-resolve from
                        the git remote via GET /apps.
  -w, --workflow ID   Workflow id as written in codemagic.yaml (default: ios-testflight,
                      override with $CODEMAGIC_WORKFLOW_ID).
  -b, --branch NAME   Branch to build (default: current git branch, else main).
      --watch         Poll the build until it finishes. Exit 0 only on success.
      --list-apps     List the team's apps and exit.
      --save-app-id   Write the resolved app id to ./.codemagic-app-id (an identifier,
                      not a secret — safe to commit).
  -h, --help          Show this help.

ONE-TIME SETUP (do this yourself — it involves a secret)
  1. Codemagic UI -> avatar (top right) -> Personal settings -> Integrations
     -> "Codemagic API" -> show/generate the API token.
  2. echo 'export CODEMAGIC_API_TOKEN="paste-token-here"' >> ~/.zshrc && source ~/.zshrc
  3. Verify: scripts/cm-build.sh --list-apps
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -a|--app-id)   APP_ID="${2:-}";      shift 2 ;;
    -w|--workflow) WORKFLOW_ID="${2:-}"; shift 2 ;;
    -b|--branch)   BRANCH="${2:-}";      shift 2 ;;
    --watch)       WATCH=1;       shift ;;
    --list-apps)   LIST_APPS=1;   shift ;;
    --save-app-id) SAVE_APP_ID=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown option: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- secrets guard
if [ -z "${CODEMAGIC_API_TOKEN:-}" ]; then
  cat >&2 <<'EOF'
cm-build: $CODEMAGIC_API_TOKEN is not set.

Generate a token in the Codemagic UI (avatar -> Personal settings -> Integrations
-> Codemagic API), then add it to your shell profile:

    echo 'export CODEMAGIC_API_TOKEN="paste-token-here"' >> ~/.zshrc
    source ~/.zshrc

Never commit the token, and never pass it on the command line.
EOF
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# ------------------------------------------------------------------ API helper
# The token is fed to curl via a config file on stdin, so it never lands in argv.
cm_api() {
  local method="$1" path="$2" body="${3:-}"
  local -a args=(-sS --fail-with-body -X "$method" -H 'Content-Type: application/json')
  if [ -n "$body" ]; then
    args+=(--data "$body")
  fi
  printf 'header = "x-auth-token: %s"\n' "$CODEMAGIC_API_TOKEN" \
    | curl "${args[@]}" --config - "${CM_API_BASE}${path}"
}

api_or_die() {
  local out rc=0
  out="$(cm_api "$@")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'cm-build: Codemagic API call failed (%s %s)\n' "$1" "$2" >&2
    [ -n "$out" ] && printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s' "$out"
}

# -------------------------------------------------------------------- list apps
if [ "$LIST_APPS" -eq 1 ]; then
  # Assign on its own line: a failure inside $( ) can only exit the subshell, so it
  # has to surface as a failed assignment for `set -e` to stop the script.
  APPS_JSON="$(api_or_die GET /apps)"
  CM_JSON="$APPS_JSON" python3 - <<'PY'
import json, os
apps = json.loads(os.environ["CM_JSON"]).get("applications", [])
if not apps:
    print("(no applications visible to this token)")
for a in apps:
    repo = (a.get("repository") or {}).get("htmlUrl", "")
    ids = list((a.get("workflows") or {}).keys()) or a.get("workflowIds") or []
    print("{}  {}".format(a.get("_id", "?"), a.get("appName", "?")))
    if repo:
        print("    repo:      " + repo)
    if ids:
        print("    workflows: " + ", ".join(str(i) for i in ids))
PY
  exit 0
fi

# ----------------------------------------------------------------- resolve app
if [ -z "$APP_ID" ] && [ -f "$REPO_ROOT/.codemagic-app-id" ]; then
  APP_ID="$(tr -d '[:space:]' < "$REPO_ROOT/.codemagic-app-id")"
fi

if [ -z "$APP_ID" ]; then
  REMOTE_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  [ -n "$REMOTE_URL" ] || die "no app id given and no git remote to resolve one from (use --app-id, or --list-apps)"
  REPO_NAME="$(basename -s .git "$REMOTE_URL")"
  info "resolving Codemagic app id for repo '$REPO_NAME'..."
  APPS_JSON="$(api_or_die GET /apps)"
  APP_ID="$(CM_JSON="$APPS_JSON" CM_REPO="$REPO_NAME" python3 - <<'PY'
import json, os, sys
want = os.environ["CM_REPO"].lower()
apps = json.loads(os.environ["CM_JSON"]).get("applications", [])
hits = []
for a in apps:
    repo = ((a.get("repository") or {}).get("htmlUrl") or "").rstrip("/").lower()
    name = (a.get("appName") or "").lower()
    if repo.endswith("/" + want) or repo.endswith("/" + want + ".git") or name == want:
        hits.append(a)
if len(hits) == 1:
    print(hits[0]["_id"])
elif not hits:
    sys.exit("cm-build: no Codemagic app matches repo %r. Run --list-apps and pass --app-id." % want)
else:
    sys.exit("cm-build: %d Codemagic apps match repo %r; pass --app-id explicitly:\n%s"
             % (len(hits), want,
                "\n".join("  %s  %s" % (h.get("_id"), h.get("appName")) for h in hits)))
PY
)"
  info "app id: $APP_ID"
  if [ "$SAVE_APP_ID" -eq 1 ]; then
    printf '%s\n' "$APP_ID" > "$REPO_ROOT/.codemagic-app-id"
    info "cached in .codemagic-app-id (identifier, not a secret — safe to commit)"
  fi
fi

# -------------------------------------------------------------- resolve branch
if [ -z "$BRANCH" ]; then
  BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  [ "$BRANCH" = "HEAD" ] && BRANCH=main
fi

# ------------------------------------------------------------------ start build
info "starting workflow '$WORKFLOW_ID' on branch '$BRANCH'"
BODY="$(CM_APP="$APP_ID" CM_WF="$WORKFLOW_ID" CM_BRANCH="$BRANCH" python3 - <<'PY'
import json, os
print(json.dumps({"appId":      os.environ["CM_APP"],
                  "workflowId": os.environ["CM_WF"],
                  "branch":     os.environ["CM_BRANCH"]}))
PY
)"

START_JSON="$(api_or_die POST /builds "$BODY")"
BUILD_ID="$(CM_JSON="$START_JSON" python3 - <<'PY'
import json, os, sys
d = json.loads(os.environ["CM_JSON"])
bid = d.get("buildId") or (d.get("build") or {}).get("_id")
if not bid:
    sys.exit("cm-build: unexpected response from POST /builds: " + json.dumps(d)[:400])
print(bid)
PY
)"

BUILD_URL="https://codemagic.io/app/${APP_ID}/build/${BUILD_ID}"
info "build started: $BUILD_ID"
info "$BUILD_URL"

[ "$WATCH" -eq 1 ] || exit 0

# ----------------------------------------------------------------------- watch
info "watching every ${POLL_SECONDS}s (Ctrl-C stops watching; the build keeps running)"
LAST=""
while :; do
  POLL_JSON="$(api_or_die GET "/builds/${BUILD_ID}")"
  STATUS="$(CM_JSON="$POLL_JSON" python3 - <<'PY'
import json, os
d = json.loads(os.environ["CM_JSON"])
b = d.get("build") or d
print(b.get("status") or "unknown")
PY
)"
  if [ "$STATUS" != "$LAST" ]; then
    printf '    [%s] %s\n' "$(date +%H:%M:%S)" "$STATUS"
    LAST="$STATUS"
  fi
  case "$STATUS" in
    finished|success|successful)
      info "final status: $STATUS"; info "$BUILD_URL"; exit 0 ;;
    failed|canceled|cancelled|skipped|timeout)
      info "final status: $STATUS"; info "$BUILD_URL"; exit 1 ;;
  esac
  sleep "$POLL_SECONDS"
done
