"use client";

/**
 * Syntax-highlighted code block with copy button.
 *
 * Uses `shiki` (VS Code's exact TextMate engine) so the colors match what
 * developers see in their editor. Theme is `vitesse-dark` to match our dark
 * Vercel-style UI.
 *
 * Languages loaded on demand (lazy `import("shiki")`) so the dashboard's
 * initial bundle stays small. A 1-line plain `<pre>` fallback renders
 * synchronously while shiki loads.
 */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export type CodeLang = "typescript" | "python" | "bash" | "yaml" | "json";

interface CodeBlockProps {
  code: string;
  lang: CodeLang;
  /** Optional filename or label shown in the header bar. */
  filename?: string;
  /** Limit visible height; long blocks scroll. */
  maxHeight?: string;
  /** Hide the copy button (rarely useful). */
  noCopy?: boolean;
  /**
   * If provided, this is what the copy button writes to the clipboard instead
   * of `code`. Useful when you want to display a masked/redacted version on
   * screen but copy the real value (e.g. tokens in WS URLs).
   */
  copyValue?: string;
}

export function CodeBlock({ code, lang, filename, maxHeight, noCopy, copyValue }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { codeToHtml } = await import("shiki");
        const result = await codeToHtml(code.trim(), {
          lang,
          theme: "vitesse-dark",
        });
        if (!cancelled) setHtml(result);
      } catch {
        // Network or import failure — fall back to the plain pre. No reason
        // to block rendering on the highlighter.
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
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — some browsers gate clipboard behind permissions/HTTPS
    }
  }

  return (
    // min-w-0 lets this shrink inside flex/grid parents (e.g. dialogs). Without
    // it, long pre lines would push the parent container wider than its
    // max-width constraint — that was the "modal overflow" bug.
    <div className="rounded-lg border border-border/40 bg-black/40 overflow-hidden text-[12.5px] min-w-0 max-w-full">
      {(filename || !noCopy) && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 bg-muted/20 min-w-0">
          <span className="font-mono text-[11px] text-muted-foreground truncate">
            {filename ?? lang}
          </span>
          {!noCopy && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCopy}
              className="h-6 px-2 text-muted-foreground hover:text-foreground shrink-0 ml-2"
              aria-label="Copy code"
            >
              {copied ? (
                <>
                  <Check className="size-3 mr-1" />
                  <span className="text-[11px]">copied</span>
                </>
              ) : (
                <>
                  <Copy className="size-3 mr-1" />
                  <span className="text-[11px]">copy</span>
                </>
              )}
            </Button>
          )}
        </div>
      )}
      {/*
        The scrollable region. `min-w-0` is critical — combined with the parent
        flex/grid, it allows shrinking; overflow-x-auto then scrolls the long
        line horizontally inside the box rather than pushing the box wider.
      */}
      <div
        className="overflow-x-auto min-w-0 max-w-full"
        style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}
      >
        {html ? (
          <div
            className="font-mono [&_pre]:!bg-transparent [&_pre]:p-3 [&_pre]:leading-relaxed [&_pre]:m-0 [&_pre]:min-w-fit"
            // Trusted: shiki only emits HTML it generated from the input.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="p-3 font-mono leading-relaxed text-foreground/90 m-0 min-w-fit">
            {code.trim()}
          </pre>
        )}
      </div>
    </div>
  );
}
