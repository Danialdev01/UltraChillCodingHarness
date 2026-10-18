#!/bin/sh
# Prints the project's `.ucch/` knowledge for an agent CLI started by hand in
# a project terminal, in the words every harness-run agent gets: the same
# text as `renderKnowledge` in packages/agent/src/prompt.ts -- keep the two in
# step. `.ucch/INFO.md` in full, then the path of everything else there.
#
#   ucch-knowledge.sh ROOT          the text, or nothing when there is none
#   ucch-knowledge.sh --toml ROOT   the same as a TOML basic string, for
#                                   `codex -c developer_instructions=...`
#
# Symlinks are neither read nor followed, as on the server: the folder is in
# a tree the repository's author controls.

toml=
if [ "$1" = "--toml" ]; then
  toml=1
  shift
fi
root=${1:?usage: ucch-knowledge.sh [--toml] ROOT}
dir=$root/.ucch

[ -d "$dir" ] && [ ! -L "$dir" ] || exit 0

info=
if [ -f "$dir/INFO.md" ] && [ ! -L "$dir/INFO.md" ]; then
  # 16 000 bytes, as MAX_INSTRUCTIONS_BYTES. Leading blank lines dropped
  # here and trailing ones by `$(...)`, like `.trim()`.
  info=$(head -c 16000 -- "$dir/INFO.md" | sed -e '/[^[:space:]]/,$!d')
fi

# 200 entries, as MAX_KNOWLEDGE_ENTRIES.
others=$(cd -- "$root" && find .ucch -type f ! -path .ucch/INFO.md 2>/dev/null | LC_ALL=C sort)
count=$(printf '%s' "$others" | grep -c .)

[ -n "$info" ] || [ "$count" -gt 0 ] || exit 0

render() {
  printf '%s' "This project keeps its knowledge for agents in \`.ucch/\`: what the project is, how it is set up, its diagrams, and whatever else has been recorded there. Read the files relevant to the task with read_file before working, refer to them, and keep them current when the project changes. \`.ucch/\` is a hidden folder, so glob, list_dir and the file list do not show it; use the paths below."
  if [ -n "$info" ]; then
    printf '\n\n--- .ucch/INFO.md ---\n%s' "$info"
  fi
  if [ "$count" -gt 0 ]; then
    printf '\n\nOther files in .ucch/:\n%s' "$(printf '%s\n' "$others" | head -n 200)"
    if [ "$count" -gt 200 ]; then printf '\n(%s more)' "$((count - 200))"; fi
  fi
  printf '\n'
}

if [ -n "$toml" ]; then
  # A TOML basic string: backslashes, quotes and control characters escaped,
  # lines joined with \n.
  render | awk '
    BEGIN { printf "\"" }
    {
      gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r")
      if (NR > 1) printf "\\n"
      printf "%s", $0
    }
    END { printf "\"" }'
else
  render
fi
