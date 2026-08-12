#!/usr/bin/env bash
# Run in CI on every push to main. Tags and releases each skill whose
# current version doesn't have a matching git tag yet. Idempotent: a skill
# whose version was already tagged in a prior run is skipped, so this
# doesn't care how many commits landed or whether they were squashed.
set -euo pipefail

for dir in skills/*/; do
  name="$(basename "$dir")"

  if [[ -f "$dir/VERSION" ]]; then
    version="$(tr -d '[:space:]' <"$dir/VERSION")"
  elif [[ -f "$dir/package.json" ]]; then
    version="$(node -p "require('./${dir}package.json').version")"
  else
    continue
  fi

  tag="$name@v$version"

  if git rev-parse "$tag" >/dev/null 2>&1; then
    echo "skip $tag: already tagged"
    continue
  fi

  echo "releasing $tag"
  git tag -a "$tag" -m "$name $version"
  git push origin "$tag"
  gh release create "$tag" \
    --title "$name $version" \
    --notes "Release $name $version. See \`${dir}CHANGELOG.md\`."
done
