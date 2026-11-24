import type { GitProvider } from "@ucch/protocol";
import { gitea } from "./gitea.js";
import { github } from "./github.js";
import { gitlab } from "./gitlab.js";
import type { GitHost } from "./types.js";

export const GIT_HOSTS: Record<GitProvider, GitHost> = { github, gitlab, gitea };
export * from "./types.js";
