# Project files for agents

Projects use `.agent/` (singular). Command buttons are defined by
`.agent/commands.json`; environment variables are stored encrypted in
`.agent/env.val`; documentation pages are stored in `.agent/notes/`.
The server reconciles documentation at startup, after editor saves, and when
watched project files change. Opening documentation also checks synchronization.

## Commands

Ask the agent in chat to inspect the project and create or update run buttons.
It edits the existing command file, preserving unrelated commands:

```json
{"commands":[{"id":"dev","label":"Run dev","command":"pnpm dev","cwd":".","icon":"play"}]}
```

The header refreshes after file changes. Clicking a button resolves its command
from disk and opens a terminal. An agent can read the same file and execute the
command with its shell tool. Merely writing a command does not execute it.

## Environment variables

The Environment Variables section saves to `.agent/env.val` and nowhere else
(no database table). Only the values are encrypted. Names, tags and urls stay
readable, so the list can show while the vault is locked:

```json
{"version":1,"kdf":{"name":"scrypt","salt":"…","N":32768,"r":8,"p":1},
 "check":"iv.tag.ciphertext",
 "vars":[{"id":"…","name":"API_TOKEN","tags":[],"url":null,"value":"iv.tag.ciphertext"}]}
```

Each value is AES-256-GCM encrypted under a key that scrypt derives from the
project key. The project key itself is never stored. `check` is a known string
encrypted the same way, so a wrong key is refused instead of returning garbage.
The file is written with mode `600`. It is meant to be committed: the variables
travel with the repository, and anyone who knows the project key can open them.
It is never served by the public site (`isSecretPath`). The values are not put
into terminals or command runs.

## Documentation

An existing page begins with frontmatter:

```markdown
---
ucch: {"id":"11111111-1111-4111-8111-111111111111","title":"Guide","parentId":"22222222-2222-4222-8222-222222222222","icon":null,"cover":null,"position":0}
---

## Getting started

Run the development server.
```

Preserve IDs. Edit the title, parent, and ordering in frontmatter. New Markdown
files may omit frontmatter and use a leading heading as their title. A directory's
`index.md` represents its parent page. Renaming an existing file updates its title;
removing it deletes the corresponding page. The root page cannot be deleted.

Text uses Markdown. Rich blocks such as drawings use fenced `ucch-node` JSON.
Some ordinary Markdown blocks have `ucch-block` comments containing their original
editor representation and a content hash. Leave these comments in place: unchanged
blocks retain all editor attributes, while edited Markdown is parsed again.
Image copies live under `.agent/references/notes/`. Do not remove assets still
referenced by pages. The database remains the collaboration and search index.

## Errors and conflicts

The editor's save indicator includes Markdown synchronization. Malformed files,
write failures, and unavailable collaboration services produce an error and keep
the file for retry. Concurrent editor/file edits preserve both versions under
`.agent/conflicts/`. Compare them, then edit the original Markdown file to resolve
the conflict. The unchanged conflicting file will not be imported automatically.
Do not edit `.agent/cache/notes-sync.json`, which tracks synchronization baselines.

Unchanged legacy exports upgrade automatically. Modified legacy exports stop
migration for review instead of overwriting either version. Compare the file with
the editor, preserve any rich content from the editor, and remove the old generated
note comment only after resolving the differences (retain the note ID in frontmatter).
