/** Isomorphic content-extraction helpers shared by the REST handlers (server +
 *  any downstream runtime). `defuddle` and `linkedom` are Workers-compatible
 *  (both verified 2026-09-01 via source-code audit — zero `node:` imports in
 *  the paths this module uses). */

/**
 * Parse HTML with linkedom and extract content with Defuddle. Dynamic-imports
 * both libraries because they are heavy (linkedom alone is ~1MB) and not always
 * needed for every REST request.
 */
export async function extractWithDefuddle(
  rawHtml: string,
  pageUrl: string,
  markdown: boolean,
) {
  const { parseHTML } = await import("linkedom");
  const { Defuddle } = await import("defuddle/node");

  const { document } = parseHTML(rawHtml);
  return Defuddle(document, pageUrl, { markdown });
}

/** Extract the standard set of metadata fields from a Defuddle result. */
export function metadataFromDefuddle(
  result: Awaited<ReturnType<typeof extractWithDefuddle>>,
): Record<string, unknown> {
  return {
    title: result.title,
    description: result.description,
    author: result.author,
    published: result.published,
    language: result.language,
    image: result.image,
    favicon: result.favicon,
    wordCount: result.wordCount,
    site: result.site,
  };
}

/**
 * Run the standard format-extraction matrix used by `/v1/content` and
 * `/v1/scrape`. Given a raw HTML string + page URL + a way to fetch the page's
 * innerText + a list of requested formats, returns the filled-in `content` map
 * and optional `metadata` object.
 */
export async function extractFormats(
  rawHtml: string,
  pageUrl: string,
  innerText: () => Promise<string>,
  formats: ReadonlyArray<"html" | "text" | "markdown" | "readability">,
): Promise<{ content: Record<string, string>; metadata: Record<string, unknown> | undefined }> {
  const content: Record<string, string> = {};
  let metadata: Record<string, unknown> | undefined;

  if (formats.includes("html")) {
    content.html = rawHtml;
  }

  if (formats.includes("text")) {
    content.text = await innerText();
  }

  const wantsMarkdown = formats.includes("markdown");
  const wantsReadability = formats.includes("readability");

  if (wantsReadability) {
    const defuddled = await extractWithDefuddle(rawHtml, pageUrl, false);
    content.readability = defuddled.content;
    metadata = metadataFromDefuddle(defuddled);
  }

  if (wantsMarkdown) {
    const mdResult = await extractWithDefuddle(rawHtml, pageUrl, true);
    content.markdown = mdResult.content;
    if (!wantsReadability) {
      metadata = metadataFromDefuddle(mdResult);
    }
  }

  return { content, metadata };
}
