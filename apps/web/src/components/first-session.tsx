import type { Project } from "@/lib/session"

/** Opening an empty project never creates a session. */
export function FirstSession({ project }: { project: Project }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm space-y-2 text-center">
        <h1 className="text-lg font-medium">{project.name}</h1>
        <p className="text-muted-foreground text-sm">
          No sessions yet. Click New session in the sidebar to start a conversation.
        </p>
      </div>
    </div>
  )
}
