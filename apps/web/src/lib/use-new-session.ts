"use client";

import * as React from "react";

import { NEW_SESSION_NAME, createProject } from "@/lib/create-project";
import { useToast } from "@/lib/realtime";
import { useTransitionRouter } from "@/lib/view-transitions";
import { useProjectHref } from "@/lib/workspace-context";

/**
 * Starts a session in a session-based workspace and opens it.
 *
 * A session is an empty project -- `git init` rather than a clone, no
 * database -- so it gets the same chat, files and terminal as any project
 * without a form to fill in. It is named "New session" until its first
 * message names it (see `ProjectChat`).
 */
export function useNewSession(workspaceId: string): { start: () => void; pending: boolean } {
  const router = useTransitionRouter();
  const hrefOf = useProjectHref();
  const toast = useToast();
  const [pending, setPending] = React.useState(false);

  const start = React.useCallback(() => {
    if (pending || !workspaceId) return;
    setPending(true);
    void createProject({ workspaceId, name: NEW_SESSION_NAME })
      .then((created) => {
        router.push(hrefOf(created.hash));
        // The sidebar's list is rendered on the server.
        router.refresh();
      })
      .catch((e: unknown) => {
        toast({
          title: "Could not start a session",
          description: e instanceof Error ? e.message : undefined,
          tone: "error",
        });
      })
      .finally(() => setPending(false));
  }, [pending, workspaceId, router, toast, hrefOf]);

  return { start, pending };
}
