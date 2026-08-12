#!/usr/bin/env bash
# Bump a skill's own version (VERSION file, or package.json for skills that
# have one). Does not commit or tag -- add a CHANGELOG.md entry, review the
# diff, then commit. Pushing to main triggers .github/workflows/release.yml,
# which tags and releases any skill whose version isn't tagged yet.
set -euo pipefail

name="${1:?usage: bump-version.sh <skill-name> [patch|minor|major]}"
level="${2:-patch}"
dir="skills/$name"

[[ -d "$dir" ]] || { echo "no such skill: $dir" >&2; exit 1; }

bump() {
  local v="$1" level="$2" major minor patch
  IFS='.' read -r major minor patch <<<"$v"
  case "$level" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    *)
      echo "unknown bump level: $level (want patch|minor|major)" >&2
      exit 1
      ;;
  esac
}

if [[ -f "$dir/VERSION" ]]; then
  old="$(tr -d '[:space:]' <"$dir/VERSION")"
  new="$(bump "$old" "$level")"
  printf '%s\n' "$new" >"$dir/VERSION"
elif [[ -f "$dir/package.json" ]]; then
  old="$(node -p "require('./$dir/package.json').version")"
  new="$(bump "$old" "$level")"
  node -e "
    const fs = require('fs');
    const p = '$dir/package.json';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.version = '$new';
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  "
else
  echo "no VERSION or package.json in $dir" >&2
  exit 1
fi

echo "$name: $old -> $new"
echo "Next: add a $dir/CHANGELOG.md entry for $new, commit, push to main."
