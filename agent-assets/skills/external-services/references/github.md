---
kind: reference
name: github
description: GitHub direct-mode reference — list repos, list PRs, comment on a PR. Autonomous tier. Stripped when `github` is not configured.
---

<!-- service:github -->
## GitHub

```bash
curl -s http://localhost:8321/api/github/repos                              # list watched repos
curl -s "http://localhost:8321/api/github/pulls?owner=user&repo=repo&state=open" # list PRs
curl -s -X POST http://localhost:8321/api/github/pulls/comment \
  -H 'Content-Type: application/json' \
  -d '{"owner": "user", "repo": "repo", "pull_number": 42, "comment": "LGTM"}' # comment — Autonomous
```

PR commenting is **user-request-only**: post a comment only when the owner
explicitly asks for it in the current conversation. Never comment
autonomously from a routine, observation, or GitHub event flow — the git /
GitHub safety policy for those paths is read-only.
<!-- /service:github -->
