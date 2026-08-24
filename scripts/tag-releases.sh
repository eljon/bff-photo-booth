#!/usr/bin/env bash
# Tag every release listed in CHANGELOG.md, then push the tags.
#
# The mapping below is the commit each version was cut from. Running this twice
# is safe: tags that already exist are left alone.
#
#   bash scripts/tag-releases.sh          # create tags locally
#   bash scripts/tag-releases.sh --push   # …and push them to origin
set -euo pipefail

releases=(
  "v1.0.0 cf357ad the booth: mobile-first guest app, three 4x6 layouts, printing through the Mac's CUPS queue"
  "v1.1.0 77d5837 guests on any network: relay mode with an outbound-only Mac agent, plus tunnel mode"
  "v1.2.0 cd076df relay deploy configs (Docker, Fly, Render, compose), health endpoint, pinned guest key, run-book"
  "v1.2.1 45bb53a fix: a tunnelled booth could lock the host out of its own controls"
  "v1.3.0 a38363f tunnels without Homebrew: direct cloudflared download, opt-in --tunnel=ssh"
  "v1.3.1 5424098 beginner setup guide; fix stale host sign-in copy"
  "v1.3.2 fb80b3e fix: stop labelling a Wi-Fi-only address as the guest link"
  "v1.4.0 bede64a pick all four photos in one tap"
  "v1.5.0 04c565c version numbers, changelog, in-app version display and npm run update"
)

for release in "${releases[@]}"; do
  tag="${release%% *}"
  rest="${release#* }"
  commit="${rest%% *}"
  message="${rest#* }"

  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "  $tag already exists"
    continue
  fi
  if ! git cat-file -e "${commit}^{commit}" 2>/dev/null; then
    echo "  skipping $tag — commit $commit is not in this clone"
    continue
  fi
  git tag -a "$tag" "$commit" -m "${tag#v} — $message"
  echo "  tagged $tag at $commit"
done

if [ "${1:-}" = "--push" ]; then
  git push origin --tags
  echo "  pushed"
else
  echo
  echo "  Run with --push to publish them:  bash scripts/tag-releases.sh --push"
fi
