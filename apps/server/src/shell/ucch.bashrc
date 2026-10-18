# The --rcfile of ucch's project terminals when the shell is bash, with
# UCCH_ROOT set to the project folder. The same guard and prompt as ucch.fish;
# see there for what it is and is not.

# A login shell's profile first: --rcfile is instead of it, not as well.
[ -f /etc/profile ] && . /etc/profile
for f in ~/.bash_profile ~/.bash_login ~/.profile; do
  [ -f "$f" ] && { . "$f"; break; }
done

builtin cd -- "$UCCH_ROOT" && UCCH_ROOT=$(pwd -P) && export UCCH_ROOT

cd() {
  if [ $# -eq 0 ] || [ "$1" = "$HOME" ]; then
    builtin cd -- "$UCCH_ROOT"
    return
  fi
  local before=$PWD
  builtin cd "$@" || return
  case "$(pwd -P)/" in
    "$UCCH_ROOT"/*) ;;
    *)
      builtin cd -- "$before"
      echo "cd: only the project folder is reachable from this terminal" >&2
      return 1
      ;;
  esac
}

__ucch_where() {
  local here
  here=$(pwd -P)
  [ "$here" = "$UCCH_ROOT" ] || printf ' %s' "${here#"$UCCH_ROOT"/}"
}
__ucch_branch() {
  local branch
  branch=$(git symbolic-ref --short HEAD 2>/dev/null) && printf ' (%s)' "$branch"
}
PS1='\u@\h$(__ucch_where)$(__ucch_branch)> '

# `claude` and `codex` started here are told about the project's `.ucch/`
# knowledge; see ucch.fish and ucch-knowledge.sh.
__ucch_knowledge=$(dirname -- "${BASH_SOURCE[0]}")/ucch-knowledge.sh

claude() {
  case "$1" in
    agents|attach|auth|auto-mode|config|doctor|gateway|import|install|logs|mcp|migrate-installer|plugin|plugins|purge|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade)
      command claude "$@"
      return
      ;;
  esac
  local knowledge
  knowledge=$(sh "$__ucch_knowledge" "$UCCH_ROOT")
  if [ -n "$knowledge" ]; then
    command claude --append-system-prompt "$knowledge" "$@"
  else
    command claude "$@"
  fi
}

codex() {
  local knowledge
  knowledge=$(sh "$__ucch_knowledge" --toml "$UCCH_ROOT")
  if [ -n "$knowledge" ]; then
    command codex -c "developer_instructions=$knowledge" "$@"
  else
    command codex "$@"
  fi
}
