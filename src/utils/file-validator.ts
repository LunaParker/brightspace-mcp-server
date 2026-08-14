/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sanitizeFilename from "sanitize-filename";

/**
 * Maximum file size for downloads (50 MB).
 * Prevents memory exhaustion from malicious large file requests.
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * Allowlist of MIME types safe for download.
 * Prevents execution of potentially malicious file types (executables, scripts).
 */
export const ALLOWED_MIME_TYPES: string[] = [
  // Documents
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/msword", // .doc
  "application/vnd.ms-powerpoint", // .ppt
  "application/vnd.ms-excel", // .xls
  // Images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Text
  "text/plain",
  "text/csv",
  "text/html",
  // Data
  "application/json",
  // Archives
  "application/zip",
  "application/x-zip-compressed",
  "application/x-7z-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-bzip2",
  // Media
  "video/mp4",
  "audio/mpeg",
  "audio/wav",
];

/**
 * Validate and sanitize download path to prevent path traversal attacks.
 *
 * @param baseDir - Base directory where downloads are allowed
 * @param filename - User-provided filename (potentially malicious)
 * @returns Validated absolute path within baseDir
 * @throws Error if path traversal detected
 */
export function validateDownloadPath(
  baseDir: string,
  filename: string
): string {
  // Decode URL-encoded characters
  const decoded = decodeURIComponent(filename);

  // Sanitize filename (removes path separators, null bytes, etc.)
  const sanitized = sanitizeFilename(decoded);

  if (!sanitized || sanitized.length === 0) {
    throw new Error("Invalid filename after sanitization");
  }

  // Resolve full path
  const fullPath = path.resolve(baseDir, sanitized);
  const resolvedBase = path.resolve(baseDir);

  // Verify resolved path is within base directory
  if (
    !fullPath.startsWith(resolvedBase + path.sep) &&
    fullPath !== resolvedBase
  ) {
    throw new Error("Path traversal detected");
  }

  return fullPath;
}

/**
 * Number of bytes inspected when sniffing whether an undetectable buffer
 * is UTF-8 text. Enough to catch binary garbage without decoding a
 * potentially 50 MB buffer.
 */
const TEXT_SNIFF_BYTES = 4096;

/**
 * True when the buffer looks like UTF-8 text: no NUL bytes anywhere, and
 * the first TEXT_SNIFF_BYTES decode with almost no invalid sequences or
 * non-whitespace control characters. Deliberately tolerant of a UTF-8 BOM
 * and non-ASCII characters (accents, smart quotes) — D2L serves HTML
 * content pages with a leading BOM, and an ASCII-only check would reject
 * every one of them.
 */
function looksLikeUtf8Text(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return false; // NUL byte → binary

  const text = buffer.subarray(0, TEXT_SNIFF_BYTES).toString("utf8");
  let total = 0;
  let suspicious = 0;
  for (const ch of text) {
    total++;
    const code = ch.codePointAt(0)!;
    if (code === 0xfffd) {
      // U+FFFD replacement character → invalid UTF-8 sequence
      suspicious++;
    } else if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      suspicious++;
    }
  }
  // Small tolerance: a sample cut at a multi-byte character boundary
  // produces one trailing U+FFFD even for perfectly valid text.
  return total > 0 && suspicious / total < 0.02;
}

/**
 * Validate file type using magic bytes (not extensions).
 * Prevents MIME type spoofing via filename manipulation.
 *
 * Text formats (HTML, CSV, plain text) have no magic bytes, so when
 * file-type detects nothing we fall back to a UTF-8 text sniff and
 * classify the buffer as text/html or text/plain.
 *
 * @param buffer - File contents to validate
 * @param allowedTypes - MIME types to allow (defaults to ALLOWED_MIME_TYPES)
 * @returns Detected MIME type and extension
 * @throws Error if file type not allowed
 */
export async function validateFileType(
  buffer: Buffer,
  allowedTypes: string[] = ALLOWED_MIME_TYPES
): Promise<{ mime: string; ext: string }> {
  // Try magic byte detection first
  const detected = await fileTypeFromBuffer(buffer);

  if (detected) {
    if (!allowedTypes.includes(detected.mime)) {
      throw new Error(
        `File type '${detected.mime}' not allowed. Allowed types: ${allowedTypes.join(", ")}`
      );
    }
    return { mime: detected.mime, ext: detected.ext };
  }

  // Fallback for text formats that file-type can't detect
  if (looksLikeUtf8Text(buffer)) {
    const sample = buffer
      .subarray(0, TEXT_SNIFF_BYTES)
      .toString("utf8")
      .replace(/^\uFEFF/, ""); // strip BOM before sniffing markup
    if (
      /^\s*<(!doctype\b|html[\s>])/i.test(sample) &&
      allowedTypes.includes("text/html")
    ) {
      return { mime: "text/html", ext: "html" };
    }
    if (allowedTypes.some((t) => t.startsWith("text/"))) {
      // Default to text/plain for other undetectable text files
      return { mime: "text/plain", ext: "txt" };
    }
  }

  throw new Error(
    "Could not determine file type or type not allowed"
  );
}

/**
 * Validate content ID is a positive integer.
 * Prevents injection via string-based IDs.
 *
 * @param id - User-provided content ID
 * @returns Validated numeric ID
 * @throws Error if ID is not a positive integer
 */
export function validateContentId(id: unknown): number {
  if (typeof id !== "number") {
    throw new Error("Content ID must be a number");
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Content ID must be a positive integer");
  }
  return id;
}

/**
 * Validate URL starts with expected D2L base URL.
 * Prevents SSRF attacks via user-controlled URLs.
 *
 * @param url - URL to validate
 * @param expectedBaseUrl - Expected D2L base URL (e.g., "https://purdue.brightspace.com")
 * @throws Error if URL doesn't match expected base
 */
export function validateBaseUrl(url: string, expectedBaseUrl: string): void {
  if (!url.startsWith(expectedBaseUrl)) {
    throw new Error(
      `URL must start with ${expectedBaseUrl}, got: ${url.substring(0, 50)}...`
    );
  }
}
