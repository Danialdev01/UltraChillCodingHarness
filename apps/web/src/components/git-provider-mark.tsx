import type { GitProvider } from "@ucch/protocol"

import { GiteaMark, GitlabMark } from "@/components/brand-marks"
import { GithubMark } from "@/components/github-mark"

const MARKS = { github: GithubMark, gitlab: GitlabMark, gitea: GiteaMark }

/** A git host's mark. */
export function GitProviderMark({ provider, className }: { provider: GitProvider; className?: string }) {
  const Mark = MARKS[provider]
  return <Mark className={className} />
}
