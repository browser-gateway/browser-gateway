"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

export type CodeLang = "typescript" | "python" | "bash" | "yaml" | "json";

interface CodeBlockProps {
  code: string;
  lang: CodeLang;
  /** Label in the header bar. Defaults to the language. */
  filename?: string;
  /** Longer blocks scroll inside this height. */
  maxHeight?: string;
  noCopy?: boolean;
  /** What Copy writes when it differs from what is shown, such as a masked token. */
  copyValue?: string;
}

/** Highlighted code with a copy button. Shiki loads lazily; a plain block shows until it does. */
export function CodeBlock({ code, lang, filename, maxHeight, noCopy, copyValue }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { codeToHtml } = await import("shiki");
        const result = await codeToHtml(code.trim(), { lang, theme: "vitesse-dark" });
        if (!cancelled) setHtml(result);
      } catch {
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText((copyValue ?? code).trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      return;
    }
  }

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-line bg-ground text-[12.5px]">
      {filename || !noCopy ? (
        <div className="flex min-w-0 items-center justify-between gap-2 border-b border-line py-1.5 pl-4 pr-1.5">
          <span className="t-mono truncate text-[11px] text-fg-3">{filename ?? lang}</span>
          {!noCopy ? (
            <button type="button" onClick={handleCopy} aria-label="Copy code" className="ui-btn ui-btn--sm ui-btn--ghost h-7 flex-none px-2.5">
              {copied ? <Check className="size-3" strokeWidth={2.2} /> : <Copy className="size-3" strokeWidth={2} />}
              <span className="text-[11px]">{copied ? "Copied" : "Copy"}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="min-w-0 max-w-full overflow-x-auto" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
        {html ? (
          <div
            className="t-mono [&_pre]:m-0 [&_pre]:min-w-fit [&_pre]:!bg-transparent [&_pre]:px-4 [&_pre]:py-3.5 [&_pre]:leading-[1.65]"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="t-mono m-0 min-w-fit px-4 py-3.5 leading-[1.65] text-[var(--text-code)]">{code.trim()}</pre>
        )}
      </div>
    </div>
  );
}
