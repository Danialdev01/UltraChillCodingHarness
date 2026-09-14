/**
 * Files a person attached to a message, before they are part of the project.
 *
 * An upload does not land in the workspace. It is held in staging -- a
 * directory outside every project tree -- and only moved in when something
 * asks for it, which is usually the model acting on "add this file to the
 * directory". Three reasons it works that way:
 *
 * A dropped file is not yet a decision. Writing every screenshot straight
 * into the checkout would put it in `git status`, in the file tree, and in
 * the next commit, and most attachments are context for a question rather
 * than material for the repository.
 *
 * The workspace is the agent's execution root. Anything written there is
 * readable by `bash` and by every file tool from the moment it exists;
 * staging keeps an unreviewed file out of that blast radius until it is
 * placed deliberately, at a path someone chose.
 *
 * And staging expires. A file nobody referred to is swept, whereas one
 * written into the checkout stays until a person notices it.
 *
 * The interface lives here, in the agent package, so the `attach_upload`
 * tool can depend on the capability without depending on the server that
 * implements it -- the same boundary `Executor` draws for command execution.
 */

/** One staged file, as the model and the composer both see it. */
export interface StagedUpload {
  /** Opaque; what `attach_upload` is given. */
  id: string;
  /** The name on the uploader's machine. Never used as a path as-is. */
  name: string;
  size: number;
  /** The browser's MIME type, or "application/octet-stream" if it had none. */
  contentType: string;
  /** ISO 8601. */
  stagedAt: string;
  /**
   * Kept past the staging window because a message shows it to the model.
   * Absent on the ordinary attachment, which still expires.
   */
  retained?: boolean;
}

/** Where an attach ended up. */
export interface AttachedUpload {
  /** The workspace-relative path the file now has. */
  path: string;
  size: number;
}

/**
 * Staging, as the tool needs it. The server's `UploadStore` implements it;
 * a turn with no staging configured simply does not get the capability.
 */
export interface UploadStaging {
  /** Everything still staged for this project, newest last. */
  list(projectId: string): Promise<StagedUpload[]>;
  /**
   * Moves a staged file into the project workspace.
   *
   * Rejects rather than overwriting: a path already in use is a decision for
   * whoever asked, not something to resolve by clobbering the repository.
   */
  attach(projectId: string, uploadId: string, path: string): Promise<AttachedUpload>;
  /**
   * Keeps a staged file past its time to live, because a message refers to it.
   * Idempotent, and silent about an id that is already gone.
   */
  retain(projectId: string, uploadId: string): Promise<void>;
  /**
   * A staged file's bytes, or null when there are none left to read.
   *
   * Null is the ordinary answer for a file that was swept or attached into
   * the workspace, and every caller renders a conversation rather than
   * failing a turn over it.
   */
  readBytes(
    projectId: string,
    uploadId: string,
  ): Promise<{ bytes: Buffer; contentType: string } | null>;
}

/** Raised when the id names nothing. Separated so the tool can say which. */
export class UnknownUploadError extends Error {}

/** Raised when the destination already exists. */
export class UploadConflictError extends Error {}
