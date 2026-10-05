/**
 * The provider's own words from a failed HTTP response. Every judge backend
 * needs this and none of them may keep it private: a status line alone cannot
 * tell a low balance from a bad key, a wrong model, a rate limit or an outage,
 * and those have four different remedies. Vendor-neutral by construction, since
 * it reads an opaque body and never a provider-specific error shape.
 */

/** How much of a failed response body is kept, in characters. */
const BODY_LIMIT = 400;

/**
 * A short suffix carrying what the endpoint said, or empty when the body is
 * unreadable or says nothing. Never throws: a failed read must not replace the
 * status error the caller is already reporting.
 */
export async function errorBodySuffix(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return `: ${trimmed.slice(0, BODY_LIMIT)}`;
}
