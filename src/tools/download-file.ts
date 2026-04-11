/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2025 Rohan Muppa. All rights reserved.
 * Licensed under AGPL-3.0 — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { DownloadFileSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import {
  validateDownloadPath,
  validateFileType,
  validateContentId,
  MAX_FILE_SIZE,
} from "../utils/file-validator.js";
import { secureDownload } from "../utils/download-helpers.js";
import fs from "node:fs/promises";
import path from "node:path";

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
        "Download a file from Brightspace to a local directory. Three sources are supported: (1) course content files via topicId, (2) the student's own dropbox submission files via folderId + fileId, and (3) instructor-uploaded attachments on a dropbox folder (assignment spec PDFs, starter-code archives, etc.) via folderId + attachmentId. Use this when the user wants to download, save, or get a file from Brightspace course content, their own submissions, or an assignment's attached files. IMPORTANT: You MUST ask the user where they want to save the file before calling this tool. Never guess or assume a download directory. After identifying the file to download, suggest a clean readable filename to the user (e.g., 'Lecture 7 - Memory Management.pdf' instead of 'L07_CS251_2026SP_v2.pdf') and ask if they'd like to rename it. Pass their preferred name as customFilename, or omit it to keep the original.",
      inputSchema: DownloadFileSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "download_file tool called", { args });

        // Parse and validate input
        const { courseId, topicId, folderId, fileId, attachmentId, downloadPath, customFilename } =
          DownloadFileSchema.parse(args);

        // fileId and attachmentId are mutually exclusive — they hit different endpoints
        if (fileId !== undefined && attachmentId !== undefined) {
          return errorResponse(
            "fileId (submission file) and attachmentId (instructor attachment) are mutually exclusive. Pass only one."
          );
        }

        // Validate courseId
        validateContentId(courseId);

        // Validate download path is absolute
        if (!path.isAbsolute(downloadPath)) {
          return errorResponse(
            "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)"
          );
        }

        // Validate download directory exists and is a directory
        try {
          const stats = await fs.stat(downloadPath);
          if (!stats.isDirectory()) {
            return errorResponse(
              `Download path is not a directory: ${downloadPath}`
            );
          }
        } catch (error: any) {
          if (error?.code === "ENOENT") {
            return errorResponse(
              `Download directory does not exist: ${downloadPath}`
            );
          }
          throw error;
        }

        // Determine download source
        if (topicId !== undefined) {
          // Content file download
          validateContentId(topicId);
          return await downloadContentFile(
            apiClient,
            courseId,
            topicId,
            downloadPath,
            customFilename
          );
        } else if (folderId !== undefined && fileId !== undefined) {
          // Student's own submission file download
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
          // Instructor-uploaded attachment on the assignment
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
 * Download a content file using topicId
 */
async function downloadContentFile(
  apiClient: D2LApiClient,
  courseId: number,
  topicId: number,
  downloadPath: string,
  customFilename?: string
): Promise<any> {
  log(
    "INFO",
    `Downloading content file: courseId=${courseId}, topicId=${topicId}`
  );

  // Build download URL using D2L API path helper
  const apiPath = apiClient.le(courseId, `/content/topics/${topicId}/file`);

  // Fetch file using getRaw (returns Response object, not parsed JSON)
  const response = await apiClient.getRaw(apiPath);

  // Check Content-Length BEFORE downloading body (prevent memory exhaustion)
  const contentLength = parseInt(
    response.headers.get("Content-Length") ?? "0",
    10
  );
  if (contentLength > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(contentLength / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  // Get filename from Content-Disposition header
  const disposition = response.headers.get("Content-Disposition") ?? "";
  let filename = "download";
  const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
  if (match?.[1]) {
    filename = match[1].replace(/['"]/g, "");
  }

  log("DEBUG", `Content-Disposition filename: ${filename}`);

  // Download body as buffer
  const buffer = Buffer.from(await response.arrayBuffer());

  // Double-check actual size
  if (buffer.length > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(buffer.length / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  // Use custom filename if provided, otherwise use Content-Disposition filename
  const originalFilename = filename;
  const effectiveFilename = customFilename || filename;

  // Use secureDownload for path traversal prevention, file type validation, and conflict resolution
  const result = await secureDownload({
    targetDir: downloadPath,
    filename: effectiveFilename,
    data: buffer,
  });

  log(
    "INFO",
    `File downloaded successfully: ${result.path} (${result.size} bytes, ${result.mime})`
  );

  return toolResponse({
    success: true,
    filePath: result.path,
    fileSize: result.size,
    mimeType: result.mime,
    originalFilename,
    message: `File downloaded successfully to ${result.path}`,
  });
}

/**
 * Download a submission/feedback file using folderId + fileId
 */
async function downloadSubmissionFile(
  apiClient: D2LApiClient,
  courseId: number,
  folderId: number,
  fileId: number,
  downloadPath: string,
  customFilename?: string
): Promise<any> {
  log(
    "INFO",
    `Downloading submission file: courseId=${courseId}, folderId=${folderId}, fileId=${fileId}`
  );

  // D2L API pattern for submission file downloads:
  // GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/(folderId)/submissions/mysubmissions/
  // Then find the file by fileId and construct its download URL

  // First, fetch the submission to get file metadata
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

  const submissions =
    await apiClient.get<DropboxSubmission[]>(submissionsPath);

  if (!submissions || submissions.length === 0) {
    return errorResponse(
      "No submissions found for this assignment. Upload a submission first."
    );
  }

  // Find the file in the submission
  const submission = submissions[0];
  const file = submission.Files.find((f) => f.FileId === fileId);

  if (!file) {
    return errorResponse(
      `File ID ${fileId} not found in submission. Available files: ${submission.Files.map((f) => `${f.FileName} (ID: ${f.FileId})`).join(", ")}`
    );
  }

  // Check file size before downloading
  if (file.Size > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(file.Size / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  // D2L file download URL pattern for submission files
  // GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/(folderId)/submissions/(submissionId)/files/(fileId)/download
  const downloadApiPath = apiClient.le(
    courseId,
    `/dropbox/folders/${folderId}/submissions/${submission.Id}/files/${fileId}/download`
  );

  // Fetch file
  const response = await apiClient.getRaw(downloadApiPath);

  // Download body as buffer
  const buffer = Buffer.from(await response.arrayBuffer());

  // Double-check actual size
  if (buffer.length > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(buffer.length / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  // Use custom filename if provided, otherwise use original submission filename
  const originalFilename = file.FileName;
  const effectiveFilename = customFilename || file.FileName;

  // Use secureDownload for path traversal prevention, file type validation, and conflict resolution
  const result = await secureDownload({
    targetDir: downloadPath,
    filename: effectiveFilename,
    data: buffer,
  });

  log(
    "INFO",
    `Submission file downloaded successfully: ${result.path} (${result.size} bytes, ${result.mime})`
  );

  return toolResponse({
    success: true,
    filePath: result.path,
    fileSize: result.size,
    mimeType: result.mime,
    originalFilename,
    message: `File downloaded successfully to ${result.path}`,
  });
}

/**
 * Download an instructor-uploaded attachment on a dropbox folder.
 *
 * These are the files the instructor attached to the assignment description
 * itself — project specs, starter code, rubric handouts, etc. They are
 * distinct from student submission files (which live under
 * .../submissions/<submissionId>/files/...). The D2L endpoint is:
 *
 *   GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/(folderId)/attachments/(fileId)
 *
 * It streams the file directly with Content-Type, Content-Length, and
 * Content-Disposition headers set, so we can reuse the same pattern used
 * for content-file downloads.
 */
async function downloadFolderAttachment(
  apiClient: D2LApiClient,
  courseId: number,
  folderId: number,
  attachmentId: number,
  downloadPath: string,
  customFilename?: string
): Promise<any> {
  log(
    "INFO",
    `Downloading folder attachment: courseId=${courseId}, folderId=${folderId}, attachmentId=${attachmentId}`
  );

  const apiPath = apiClient.le(
    courseId,
    `/dropbox/folders/${folderId}/attachments/${attachmentId}`
  );

  const response = await apiClient.getRaw(apiPath);

  // Pre-check Content-Length to fail fast on oversized files without buffering
  const contentLength = parseInt(
    response.headers.get("Content-Length") ?? "0",
    10
  );
  if (contentLength > MAX_FILE_SIZE) {
    return errorResponse(
      `Attachment too large (${Math.round(contentLength / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  // Parse filename from Content-Disposition. The D2L response uses the
  // RFC 5987 extended form: filename*=UTF-8''Project.pdf; filename="Project.pdf"
  // We try the extended form first, then fall back to the plain quoted form.
  const disposition = response.headers.get("Content-Disposition") ?? "";
  let filename = "attachment";
  const extMatch = disposition.match(/filename\*\s*=\s*(?:UTF-8'')?([^;\n]+)/i);
  if (extMatch?.[1]) {
    try {
      filename = decodeURIComponent(extMatch[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      filename = extMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  } else {
    const plainMatch = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (plainMatch?.[1]) {
      filename = plainMatch[1].replace(/['"]/g, "");
    }
  }
  log("DEBUG", `Attachment Content-Disposition filename: ${filename}`);

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > MAX_FILE_SIZE) {
    return errorResponse(
      `Attachment too large (${Math.round(buffer.length / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  const originalFilename = filename;
  const effectiveFilename = customFilename || filename;

  const result = await secureDownload({
    targetDir: downloadPath,
    filename: effectiveFilename,
    data: buffer,
  });

  log(
    "INFO",
    `Folder attachment downloaded successfully: ${result.path} (${result.size} bytes, ${result.mime})`
  );

  return toolResponse({
    success: true,
    filePath: result.path,
    fileSize: result.size,
    mimeType: result.mime,
    originalFilename,
    message: `Attachment downloaded successfully to ${result.path}`,
  });
}
