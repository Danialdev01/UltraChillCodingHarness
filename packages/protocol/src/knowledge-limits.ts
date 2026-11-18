/**
 * How big a knowledge document may be, and the pieces it is sent in. Plain
 * constants, shared by the server and the browser (`@ucch/protocol/plain`).
 *
 * A document is uploaded in chunks rather than one request: no proxy in
 * front of the API has to hold a 2.5 GB body, and the server appends each
 * piece to a file instead of holding it in memory.
 */

/** The largest knowledge document: 2.5 GB. */
export const MAX_KNOWLEDGE_DOCUMENT_BYTES = 2.5 * 1024 * 1024 * 1024;

/** One upload chunk: well under every proxy's default body limit. */
export const KNOWLEDGE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
