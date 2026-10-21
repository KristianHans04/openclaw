import { parseDateStringTimestampMs } from "../../packages/normalization-core/src/number-coercion.js";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { externalContentStamp } from "../agents/tools/web-search-provider-common.js";
import { truncateSanitizedExternalContent, wrapWebContent } from "../security/external-content.js";

const TAVILY_SEARCH_MAX_CONTENT_CHARS = 20_000;
const TAVILY_RESULT_URL_MAX_CHARS = 2_048;
const TAVILY_PUBLISHED_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+Z-]{0,20})?$/u;

export function normalizeTavilyResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > TAVILY_RESULT_URL_MAX_CHARS) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.href.length > TAVILY_RESULT_URL_MAX_CHARS
    ) {
      return undefined;
    }
    return url.href === `${value}/` ? value : url.href;
  } catch {
    return undefined;
  }
}

function normalizeTavilyPublishedDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 31) {
    return undefined;
  }
  if (TAVILY_PUBLISHED_DATE_RE.test(value)) {
    // Preserve accepted timestamp suffixes while rejecting impossible calendar dates.
    const calendarDate = value.slice(0, 10);
    const timestamp = parseDateStringTimestampMs(calendarDate);
    return timestamp !== undefined && new Date(timestamp).toISOString().startsWith(calendarDate)
      ? value
      : undefined;
  }
  // Tavily news dates use RFC-style GMT. Exact round-tripping rejects prose,
  // relative ages, and invalid calendar dates before emitting an unwrapped field.
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toUTCString() === value
    ? date.toISOString()
    : undefined;
}

/** Shared Tavily wire normalization; routing, auth, transport and caching stay caller-owned. */
export function normalizeTavilySearchResponse(
  payload: Record<string, unknown>,
  params: {
    query: string;
    count: number;
    provider: string;
    tookMs: number;
  },
): Record<string, unknown> {
  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  let remainingSearchContentChars = TAVILY_SEARCH_MAX_CONTENT_CHARS;
  let searchTruncated = rawResults.length > params.count;
  const wrapBoundedSearchContent = (value: string): string => {
    const bounded = truncateSanitizedExternalContent(value, remainingSearchContentChars);
    searchTruncated ||= bounded.truncated;
    remainingSearchContentChars -= bounded.text.length;
    return wrapWebContent(bounded.text, "web_search");
  };
  const results = rawResults.slice(0, params.count).flatMap((entry: unknown) => {
    if (!isRecord(entry)) {
      return [];
    }
    const url = normalizeTavilyResultUrl(entry.url);
    if (!url) {
      return [];
    }
    const published = normalizeTavilyPublishedDate(entry.published_date);
    return [
      {
        title: typeof entry.title === "string" ? wrapBoundedSearchContent(entry.title) : "",
        url,
        snippet: typeof entry.content === "string" ? wrapBoundedSearchContent(entry.content) : "",
        score: typeof entry.score === "number" ? entry.score : undefined,
        ...(published ? { published } : {}),
      },
    ];
  });

  const result: Record<string, unknown> = {
    query: params.query,
    provider: params.provider,
    count: results.length,
    tookMs: params.tookMs,
    externalContent: externalContentStamp(params.provider),
    results,
  };
  if (typeof payload.answer === "string" && payload.answer) {
    result.answer = wrapBoundedSearchContent(payload.answer);
  }
  if (searchTruncated) {
    result.truncated = true;
  }

  return result;
}
