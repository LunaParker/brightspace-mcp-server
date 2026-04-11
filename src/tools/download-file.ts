/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2025 Rohan Muppa. All rights reserved.
 * Licensed under AGPL-3.0 — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { D2LApiClient } from "../api/index.js";
import { DownloadFileSchema } from "./schemas.js";
import { errorResponse, sanitizeError, toolResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import {
  validateContentId,
  validateFileType,
  MAX_FILE_SIZE,
} from "../utils/file-validator.js";
import { secureDownload } from "../utils/download-helpers.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Maximum file size we are willing to embed inline in a tool response.
 * Base64 encoding adds ~33% overhead, so a 10 MB file becomes ~13.3 MB of
 * JSON. That is large but tolerable; anything bigger should be written to
 * disk via `downloadPath` or consumed some other way.
 */
const INLINE_MAX_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Maximum number of characters of extracted PDF text we'll inline into a
 * tool response. 400 KB of text is already ~100k tokens — enough for most
 * assignment PDFs, and a hard cap protects us from runaway documents.
 */
const INLINE_PDF_TEXT_MAX_CHARS = 400_000;

/**
 * Parse a Content-Disposition header and return the filename. Handles both
 * the plain form (`filename="foo.pdf"`) and the RFC 5987 extended form
 * (`filename*=UTF-8''Project.pdf`) used by D2L.
 */
function parseContentDispositionFilename(
  disposition: string,
  fallback: string
): string {
  const extMatch = disposition.match(/filename\*\s*=\s*(?:UTF-8'')?([^;\n]+)/i);
  if (extMatch?.[1]) {
    try {
      return decodeURIComponent(extMatch[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      return extMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  const plainMatch = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
  if (plainMatch?.[1]) {
    return plainMatch[1].replace(/['"]/g, "");
  }
  return fallback;
}

/**
 * Respond with a downloaded file, choosing between two modes:
 *
 * - **Disk mode** (`downloadPath` provided): writes the file to the host
 *   filesystem via `secureDownload`. Returns a JSON metadata blob.
 *
 * - **Inline mode** (`downloadPath` omitted): returns the file content
 *   directly in the MCP tool response. This is the correct mode inside
 *   Claude Desktop, where MCP servers run on the host filesystem but
 *   Claude's own analysis/bash tool runs in a separate sandbox that
 *   cannot see files the MCP server writes to disk. Inline mode picks
 *   the best content block for the file type:
 *     - PDFs → extracted text (via `extractPdfText`) so the model can
 *       read the content directly, plus an embedded resource blob so
 *       clients that render MCP resources can still surface the raw file.
 *     - Images → `ImageContent` (Claude reads images natively).
 *     - Text/JSON → embedded resource with `text` payload.
 *     - Everything else → embedded resource with `blob` (base64) payload.
 *
 * All responses start with a JSON metadata header so the caller can see
 * the filename, MIME type, and byte size regardless of mode.
 */
async function respondWithFile(options: {
  buffer: Buffer;
  originalFilename: string;
  downloadPath?: string;
  customFilename?: string;
  sourceLabel: string; // for logging
}): Promise<CallToolResult> {
  const { buffer, originalFilename, downloadPath, customFilename, sourceLabel } =
    options;

  // Hard cap applies to both modes — we never stream more than MAX_FILE_SIZE
  // out of D2L regardless of where it ends up.
  if (buffer.length > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(buffer.length / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  const effectiveFilename = customFilename || originalFilename;

  // ── Disk mode ──────────────────────────────────────────────────────────
  if (downloadPath !== undefined) {
    if (!path.isAbsolute(downloadPath)) {
      return errorResponse(
        "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)"
      );
    }

    try {
      const stats = await fs.stat(downloadPath);
      if (!stats.isDirectory()) {
        return errorResponse(`Download path is not a directory: ${downloadPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return errorResponse(
          `Download directory does not exist on the host filesystem: ${downloadPath}. Note: Claude Desktop's analysis/bash sandbox paths (like /mnt/user-data/*) are NOT accessible from MCP servers — omit downloadPath entirely to receive the file inline in the tool response instead.`
        );
      }
      throw error;
    }

    const result = await secureDownload({
      targetDir: downloadPath,
      filename: effectiveFilename,
      data: buffer,
    });

    log(
      "INFO",
      `${sourceLabel} downloaded to disk: ${result.path} (${result.size} bytes, ${result.mime})`
    );

    return toolResponse({
      mode: "disk",
      success: true,
      filePath: result.path,
      fileSize: result.size,
      mimeType: result.mime,
      originalFilename,
      message: `File downloaded successfully to ${result.path}`,
    });
  }

  // ── Inline mode ────────────────────────────────────────────────────────
  if (buffer.length > INLINE_MAX_SIZE) {
    return errorResponse(
      `File too large for inline delivery (${Math.round(buffer.length / 1024 / 1024)}MB, inline max ${INLINE_MAX_SIZE / 1024 / 1024}MB). Provide an absolute downloadPath on the host filesystem to save it to disk instead.`
    );
  }

  // Detect MIME type via magic bytes (enforces allowlist, same as disk mode).
  let mime: string;
  try {
    const detected = await validateFileType(buffer);
    mime = detected.mime;
  } catch (err) {
    return errorResponse(
      `File type not allowed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const uri = `brightspace://inline/${encodeURIComponent(effectiveFilename)}`;
  const content: CallToolResult["content"] = [];

  // Metadata header
  content.push({
    type: "text",
    text: JSON.stringify(
      {
        mode: "inline",
        filename: effectiveFilename,
        originalFilename,
        mimeType: mime,
        size: buffer.length,
        source: "brightspace",
        note:
          "File content follows as inline MCP content blocks. No disk write was performed. Use downloadPath to save to disk instead when running outside Claude Desktop.",
      },
      null,
      2
    ),
  });

  if (mime === "application/pdf") {
    // Extract text so the model can actually read the contents. The raw
    // PDF is also embedded as a resource blob for clients that can render
    // it (and as a fallback if extraction fails or is truncated).
    const extracted = await extractPdfText(buffer);
    if (extracted && extracted.text) {
      const truncated = extracted.text.length > INLINE_PDF_TEXT_MAX_CHARS;
      const text = truncated
        ? extracted.text.slice(0, INLINE_PDF_TEXT_MAX_CHARS) +
          `\n\n[...extracted text truncated at ${INLINE_PDF_TEXT_MAX_CHARS} characters; ${extracted.text.length - INLINE_PDF_TEXT_MAX_CHARS} more characters exist in the source PDF...]`
        : extracted.text;
      content.push({
        type: "text",
        text: `--- Extracted PDF text (${extracted.totalPages} page${extracted.totalPages === 1 ? "" : "s"})${truncated ? ", truncated" : ""} ---\n${text}`,
      });
    } else {
      content.push({
        type: "text",
        text: "--- PDF text extraction failed or produced no text; the raw PDF is attached as an embedded resource below. ---",
      });
    }
    content.push({
      type: "resource",
      resource: {
        uri,
        mimeType: mime,
        blob: buffer.toString("base64"),
      },
    });
  } else if (mime.startsWith("image/")) {
    content.push({
      type: "image",
      data: buffer.toString("base64"),
      mimeType: mime,
    });
  } else if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml"
  ) {
    content.push({
      type: "resource",
      resource: {
        uri,
        mimeType: mime,
        text: buffer.toString("utf8"),
      },
    });
  } else {
    content.push({
      type: "resource",
      resource: {
        uri,
        mimeType: mime,
        blob: buffer.toString("base64"),
      },
    });
  }

  log(
    "INFO",
    `${sourceLabel} returned inline: ${effectiveFilename} (${buffer.length} bytes, ${mime})`
  );

  return { content };
}

/**
 * Register download_file tool
 */
export function registerDownloadFile(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "download_file",
    {
      title: "Download File",
      description:
        "Download a file from Brightspace. Three sources are supported: (1) course content files via topicId, (2) the student's own dropbox submission files via folderId + fileId, and (3) instructor-uploaded attachments on a dropbox folder via folderId + attachmentId. " +
        "Two response modes are supported: " +
        "(A) INLINE MODE (default, and the right choice inside Claude Desktop): omit downloadPath. The file is returned directly in the tool response as inline MCP content — extracted text for PDFs, an image block for images, or an embedded resource blob for other types. You can read the content immediately without touching any filesystem. " +
        "(B) DISK MODE: set downloadPath to an absolute path on the HOST filesystem (the same filesystem the MCP server process runs on). The file is written there via a secure-download pipeline with path-traversal prevention. IMPORTANT: Claude Desktop's analysis/bash sandbox paths (like /mnt/user-data/outputs, /mnt/user-data/tool_results) are NOT accessible from MCP servers — do not use them as downloadPath. Only use disk mode when the user explicitly wants a file saved to a real host path they can open in Finder/Explorer. " +
        "When the user wants to save a file to disk, ask them for an absolute path on their machine and suggest a clean readable filename via customFilename. When the user just wants you to read or analyze the file, use inline mode (omit downloadPath).",
      inputSchema: DownloadFileSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "download_file tool called", { args });

        const { courseId, topicId, folderId, fileId, attachmentId, downloadPath, customFilename } =
          DownloadFileSchema.parse(args);

        if (fileId !== undefined && attachmentId !== undefined) {
          return errorResponse(
            "fileId (submission file) and attachmentId (instructor attachment) are mutually exclusive. Pass only one."
          );
        }

        validateContentId(courseId);

        if (topicId !== undefined) {
          validateContentId(topicId);
          return await downloadContentFile(
            apiClient,
            courseId,
            topicId,
            downloadPath,
            customFilename
          );
        } else if (folderId !== undefined && fileId !== undefined) {
          validateContentId(folderId);
          validateContentId(fileId);
          return await downloadSubmissionFile(
            apiClient,
            courseId,
            folderId,
            fileId,
            downloadPath,
            customFilename
          );
        } else if (folderId !== undefined && attachmentId !== undefined) {
          validateContentId(folderId);
          validateContentId(attachmentId);
          return await downloadFolderAttachment(
            apiClient,
            courseId,
            folderId,
            attachmentId,
            downloadPath,
            customFilename
          );
        } else {
          return errorResponse(
            "You must provide one of: topicId (for course content), folderId + fileId (for your own submission files), or folderId + attachmentId (for instructor-uploaded assignment attachments)."
          );
        }
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}

/**
 * Download a course content file using topicId.
 */
async function downloadContentFile(
  apiClient: D2LApiClient,
  courseId: number,
  topicId: number,
  downloadPath: string | undefined,
  customFilename: string | undefined
): Promise<CallToolResult> {
  log(
    "INFO",
    `Fetching content file: courseId=${courseId}, topicId=${topicId}`
  );

  const apiPath = apiClient.le(courseId, `/content/topics/${topicId}/file`);
  const response = await apiClient.getRaw(apiPath);

  // Pre-check Content-Length so we fail fast on oversized files without
  // buffering the whole response.
  const contentLength = parseInt(response.headers.get("Content-Length") ?? "0", 10);
  if (contentLength > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(contentLength / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  const originalFilename = parseContentDispositionFilename(
    response.headers.get("Content-Disposition") ?? "",
    "download"
  );
  const buffer = Buffer.from(await response.arrayBuffer());

  return respondWithFile({
    buffer,
    originalFilename,
    downloadPath,
    customFilename,
    sourceLabel: "Content file",
  });
}

/**
 * Download the student's own submission file using folderId + fileId.
 */
async function downloadSubmissionFile(
  apiClient: D2LApiClient,
  courseId: number,
  folderId: number,
  fileId: number,
  downloadPath: string | undefined,
  customFilename: string | undefined
): Promise<CallToolResult> {
  log(
    "INFO",
    `Fetching submission file: courseId=${courseId}, folderId=${folderId}, fileId=${fileId}`
  );

  const submissionsPath = apiClient.le(
    courseId,
    `/dropbox/folders/${folderId}/submissions/mysubmissions/`
  );

  interface DropboxSubmission {
    Id: number;
    Files: Array<{
      FileId: number;
      FileName: string;
      Size: number;
    }>;
  }

  const submissions = await apiClient.get<DropboxSubmission[]>(submissionsPath);

  if (!submissions || submissions.length === 0) {
    return errorResponse(
      "No submissions found for this assignment. Upload a submission first."
    );
  }

  const submission = submissions[0];
  const file = submission.Files.find((f) => f.FileId === fileId);

  if (!file) {
    return errorResponse(
      `File ID ${fileId} not found in submission. Available files: ${submission.Files.map((f) => `${f.FileName} (ID: ${f.FileId})`).join(", ")}`
    );
  }

  if (file.Size > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(file.Size / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  const downloadApiPath = apiClient.le(
    courseId,
    `/dropbox/folders/${folderId}/submissions/${submission.Id}/files/${fileId}/download`
  );
  const response = await apiClient.getRaw(downloadApiPath);
  const buffer = Buffer.from(await response.arrayBuffer());

  return respondWithFile({
    buffer,
    originalFilename: file.FileName,
    downloadPath,
    customFilename,
    sourceLabel: "Submission file",
  });
}

/**
 * Download an instructor-uploaded attachment on a dropbox folder using
 * folderId + attachmentId (the FileId from get_assignments' `attachments`
 * array). Hits the D2L endpoint:
 *
 *   GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/(folderId)/attachments/(fileId)
 */
async function downloadFolderAttachment(
  apiClient: D2LApiClient,
  courseId: number,
  folderId: number,
  attachmentId: number,
  downloadPath: string | undefined,
  customFilename: string | undefined
): Promise<CallToolResult> {
  log(
    "INFO",
    `Fetching folder attachment: courseId=${courseId}, folderId=${folderId}, attachmentId=${attachmentId}`
  );

  const apiPath = apiClient.le(
    courseId,
    `/dropbox/folders/${folderId}/attachments/${attachmentId}`
  );
  const response = await apiClient.getRaw(apiPath);

  const contentLength = parseInt(response.headers.get("Content-Length") ?? "0", 10);
  if (contentLength > MAX_FILE_SIZE) {
    return errorResponse(
      `Attachment too large (${Math.round(contentLength / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  const originalFilename = parseContentDispositionFilename(
    response.headers.get("Content-Disposition") ?? "",
    "attachment"
  );
  const buffer = Buffer.from(await response.arrayBuffer());

  return respondWithFile({
    buffer,
    originalFilename,
    downloadPath,
    customFilename,
    sourceLabel: "Folder attachment",
  });
}
