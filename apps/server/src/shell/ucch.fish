# Sourced by ucch's project terminals (fish -l -C), after the user's own
# config, with UCCH_ROOT set to the project folder.
#
# Keeps the session in the project: `cd`, `cd ~` and `cd ..` at the top all
# land on the project folder, anything that would leave it is turned back,
# and the prompt shows the path from there rather than from `/`. The guard is
# on PWD itself rather than in `cd`, which also catches pushd, prevd and a
# `builtin cd`.
#
# This is the shell keeping to the folder, not a sandbox: `ls /` still lists
# `/`. The container runtime is where the real boundary will be.

builtin cd -- $UCCH_ROOT
set -gx UCCH_ROOT (builtin realpath -- $UCCH_ROOT)
set -g __ucch_last $UCCH_ROOT

function __ucch_inside --argument-names dir
    set -l root $UCCH_ROOT/
    set -l head (string sub --length (string length -- $root) -- (builtin realpath -- $dir)/)
    test "$head" = "$root"
end

function __ucch_guard --on-variable PWD
    if __ucch_inside $PWD
        set -g __ucch_last $PWD
    else
        set -g __ucch_refused 1
        builtin cd -- $__ucch_last
        echo "cd: only the project folder is reachable from this terminal" >&2
    end
end

# fish's own cd is a function (it handles `cd -` and the directory history);
# kept and called, so all of that still works.
functions -q cd; and functions --copy cd __ucch_cd
function cd --description 'Change directory within the project'
    set -e __ucch_refused
    if test (count $argv) -eq 0; or test "$argv[1]" = "$HOME"
        builtin cd -- $UCCH_ROOT
    else if functions -q __ucch_cd
        __ucch_cd $argv
    else
        builtin cd $argv
    end
    or return
    set -q __ucch_refused; and return 1
    return 0
end

# fish's default prompt, with the path relative to the project and left out
# entirely at its top: `danial@dbot (main)>`, `danial@dbot src (main)>`.
function fish_prompt --description 'Write out the prompt'
    set -l last_pipestatus $pipestatus
    set -lx __fish_last_status $status
    # Colours in variables and quoted: an unset colour is an empty list, and
    # an empty list beside anything else in fish makes the whole word empty.
    set -l normal (set_color normal)
    set -l color_cwd (set_color $fish_color_cwd)
    set -l status_color (set_color $fish_color_status)
    set -l statusb_color (set_color --bold $fish_color_status)
    set -l here (builtin realpath -- $PWD)
    set -l where
    if test "$here" != "$UCCH_ROOT"
        set -l relative (string replace -- "$UCCH_ROOT/" '' $here)
        set where " $color_cwd$relative$normal"
    end
    set -l prompt_status (__fish_print_pipestatus "[" "]" "|" "$status_color" "$statusb_color" $last_pipestatus)
    echo -n -s (prompt_login) "$where" (fish_vcs_prompt) "$normal" " "$prompt_status "> "
end

# `claude` and `codex` started here are told about the project's `.ucch/`
# knowledge, as every agent the harness runs is; see ucch-knowledge.sh.
# Subcommands that start no session (`claude auth`, `claude mcp`, ...) are
# passed through untouched.
set -g __ucch_knowledge (path dirname -- (status filename))/ucch-knowledge.sh

function claude --wraps claude --description "claude, told about the project's .ucch/ folder"
    switch "$argv[1]"
        case agents attach auth auto-mode config doctor gateway import install logs mcp migrate-installer plugin plugins purge respawn rm setup-token stop kill ultrareview update upgrade
            command claude $argv
            return
    end
    set -l knowledge (sh $__ucch_knowledge $UCCH_ROOT | string collect)
    if test -n "$knowledge"
        command claude --append-system-prompt $knowledge $argv
    else
        command claude $argv
    end
end

function codex --wraps codex --description "codex, told about the project's .ucch/ folder"
    set -l knowledge (sh $__ucch_knowledge --toml $UCCH_ROOT | string collect)
    if test -n "$knowledge"
        command codex -c "developer_instructions=$knowledge" $argv
    else
        command codex $argv
    end
end
