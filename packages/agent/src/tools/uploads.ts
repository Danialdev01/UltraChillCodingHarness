import { z } from "zod/v4";
import { defineTool, type ToolResult } from "../tool.js";
import { UnknownUploadError, UploadConflictError } from "../uploads.js";
import { languageOf } from "./format.js";

/** Bytes, for a sentence the model reads back to the user. */
function bytes(size: number): string {
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Places a file the person attached into the workspace.
 *
 * The one operation staging needs a tool for. Listing is not: every message
 * that carries attachments names them, with their ids, in the text the model
 * already reads, so a `list_uploads` call would spend a round trip
 * rediscovering what is a few lines up the conversation.
 *
 * A binary attachment cannot reach the model any other way -- an image is not
 * text and `read_file` would refuse it even once it landed -- so for those
 * this is the only path from "the user sent it" to "it is in the project".
 */
export const attachUpload = defineTool({
  name: "attach_upload",
  description:
    "Move a file the user attached to the conversation into the project workspace. " +
    "Attachments are staged outside the workspace until placed with this tool, so use it " +
    "when the user asks for an attached file to be added to the project. The upload_id " +
    "is given beside each attachment in the message that carried it. Works for any file, " +
    "including images and other binary formats that cannot be written with write_file.",
  permission: "write",
  inputSchema: z.strictObject({
    upload_id: z.string().describe("The id shown beside the attachment in the user's message"),
    path: z
      .string()
      .describe(
        "Where to put it, relative to the workspace root, e.g. public/images/logo.png. " +
          "Include the filename; parent directories are created as needed.",
      ),
  }),
  async run(input, ctx): Promise<ToolResult> {
    if (!ctx.uploads) {
      return {
        content: "This harness has no attachment staging configured, so there is nothing to attach.",
        isError: true,
      };
    }

    try {
      const attached = await ctx.uploads.attach(ctx.projectId, input.upload_id, input.path);

      // The same event `write_file` emits, so a file placed from an
      // attachment reaches the file tree and any open editor by the path
      // every other change takes.
      await ctx.emit({
        type: "file.changed",
        projectId: ctx.projectId,
        path: attached.path,
        change: "added",
      });

      return {
        content: `Added ${attached.path} (${bytes(attached.size)}) from the user's attachment.`,
        display: { path: attached.path, language: languageOf(attached.path) },
      };
    } catch (error) {
      if (error instanceof UnknownUploadError) {
        return {
          content:
            `No attachment with id ${input.upload_id} is staged for this project. ` +
            "Staged files expire, and each one can only be placed once -- check the id in the " +
            "message that carried the attachment, or ask the user to attach it again.",
          isError: true,
        };
      }
      if (error instanceof UploadConflictError) {
        return {
          content: `${input.path} already exists. Choose another path, or remove it first.`,
          isError: true,
        };
      }
      return {
        content: `Could not attach the file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
});
