/**
 * Shared record-line utilities for the statement parsers.
 *
 * RDR-R messages are "LF or CRLF record separated" and CWR files are "CRLF
 * delimited" — both may arrive with either line ending, and a final line
 * terminator produces one trailing empty string when naively split. The
 * parsers therefore share one splitter: it accepts LF, CRLF and lone CR
 * separators and drops only the single trailing empty caused by a final
 * terminator. Any empty line INSIDE the file stays a parse error upstream.
 */

/** Splits statement content into record lines, tolerating the final terminator. */
export function splitRecordLines(content: string): readonly string[] {
  const raw = content.split(/\r\n|\r|\n/);
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return raw;
}
