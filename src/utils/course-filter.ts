/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2025 Rohan Muppa. All rights reserved.
 * Licensed under AGPL-3.0 — see LICENSE file for details.
 */

import type { CourseFilterConfig } from "../types/index.js";
import { log } from "./logger.js";

interface FilterableCourse {
  id: number;
  isActive: boolean;
  /**
   * Enrollment availability dates from D2L's /enrollments/myenrollments/
   * response (Access.StartDate / Access.EndDate). Used by the currentOnly
   * filter. Either may be null — null means "open-ended" on that side.
   */
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * True if `now` falls within [startDate, endDate].
 *
 * When both dates are null the course has no enrollment window at all —
 * it's almost certainly an informational org unit (e.g. "Waterloo Campus",
 * "Academic Integrity") rather than a term-bound course, so we return
 * false. A single null side is treated as open-ended (start-only means
 * "not yet ended", end-only means "already started").
 */
function isCurrentlyInWindow(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  now: number
): boolean {
  // Both null → undated org unit, not a current semester course.
  if (!startDate && !endDate) return false;

  if (startDate) {
    const start = Date.parse(startDate);
    if (!Number.isNaN(start) && start > now) return false;
  }
  if (endDate) {
    const end = Date.parse(endDate);
    if (!Number.isNaN(end) && end < now) return false;
  }
  return true;
}

/**
 * Apply course filtering based on environment variable configuration.
 *
 * Filter priority:
 * 1. activeOnly — exclude inactive enrollments (default: true)
 * 2. currentOnly — exclude courses outside their availability window (default: false)
 * 3. includeCourseIds — whitelist (only these courses)
 * 4. excludeCourseIds — blacklist (remove these courses)
 *
 * Tool-level courseId params bypass this filter entirely —
 * if user explicitly requests courseId=X, honor it regardless of config.
 */
export function applyCourseFilter<T extends FilterableCourse>(
  courses: T[],
  config: CourseFilterConfig,
  now: number = Date.now()
): T[] {
  let filtered = courses;
  const originalCount = courses.length;

  if (config.activeOnly) {
    filtered = filtered.filter(c => c.isActive);
  }

  if (config.currentOnly) {
    filtered = filtered.filter(c =>
      isCurrentlyInWindow(c.startDate, c.endDate, now)
    );
  }

  if (config.includeCourseIds && config.includeCourseIds.length > 0) {
    filtered = filtered.filter(c => config.includeCourseIds!.includes(c.id));
  }

  if (config.excludeCourseIds && config.excludeCourseIds.length > 0) {
    filtered = filtered.filter(c => !config.excludeCourseIds!.includes(c.id));
  }

  if (filtered.length !== originalCount) {
    log("DEBUG", `Course filter: ${originalCount} -> ${filtered.length} courses`, {
      activeOnly: config.activeOnly,
      currentOnly: config.currentOnly,
      include: config.includeCourseIds,
      exclude: config.excludeCourseIds,
    });
  }

  return filtered;
}
