"use client";

/**
 * Renders an endpoint's reference documentation: headers, parameters table,
 * request body example, response example, error codes. Driven by a structured
 * `EndpointDoc` object so each endpoint section on the API page stays
 * consistent in layout.
 */
import { CodeBlock } from "./code-block";

export interface DocParameter {
  name: string;
  type: string;
  required?: boolean;
  default?: string;
  description: string;
}

export interface DocHeader {
  name: string;
  value: string;
  note?: string;
}

export interface DocError {
  status: number;
  meaning: string;
}

export interface EndpointDoc {
  description: string;
  headers: DocHeader[];
  parameters: DocParameter[];
  /** JSON sample of the request body. */
  requestExample: string;
  /** Plain-language description of what's returned. */
  responseDescription: string;
  /** JSON sample of the response, or `null` for binary responses. */
  responseExample: string | null;
  /** Optional list of response headers worth documenting (e.g. X-Response-Code). */
  responseHeaders?: { name: string; description: string }[];
  errors: DocError[];
}

export function EndpointReference({ doc }: { doc: EndpointDoc }) {
  return (
    <div className="space-y-6">
      <p className="text-[13px] text-muted-foreground leading-relaxed">{doc.description}</p>

      <Section title="Headers">
        <KvTable
          rows={doc.headers.map((h) => ({
            name: h.name,
            type: h.value,
            description: h.note ?? "",
          }))}
          nameLabel="Header"
          typeLabel="Value"
        />
      </Section>

      <Section title="Request body">
        <KvTable rows={doc.parameters.map(parameterRow)} />
        <p className="text-[11.5px] text-muted-foreground pt-2">Example:</p>
        <CodeBlock code={doc.requestExample} lang="json" filename="request.json" />
      </Section>

      <Section title="Response">
        <p className="text-[13px] text-muted-foreground">{doc.responseDescription}</p>
        {doc.responseExample && (
          <CodeBlock code={doc.responseExample} lang="json" filename="response.json" />
        )}
        {doc.responseHeaders && doc.responseHeaders.length > 0 && (
          <>
            <p className="text-[11.5px] text-muted-foreground pt-2">Response headers:</p>
            <KvTable
              rows={doc.responseHeaders.map((h) => ({
                name: h.name,
                type: "",
                description: h.description,
              }))}
              nameLabel="Header"
              typeLabel=""
            />
          </>
        )}
      </Section>

      <Section title="Status codes">
        <KvTable
          rows={doc.errors.map((e) => ({
            name: String(e.status),
            type: "",
            description: e.meaning,
          }))}
          nameLabel="Status"
          typeLabel=""
        />
      </Section>
    </div>
  );
}

function parameterRow(p: DocParameter): KvRow {
  const typePart = p.required ? `${p.type} • required` : p.default ? `${p.type} • default: ${p.default}` : p.type;
  return { name: p.name, type: typePart, description: p.description };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

interface KvRow {
  name: string;
  type: string;
  description: string;
}

function KvTable({
  rows,
  nameLabel = "Field",
  typeLabel = "Type",
}: {
  rows: KvRow[];
  nameLabel?: string;
  typeLabel?: string;
}) {
  return (
    <div className="rounded border border-border/40 overflow-hidden">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-border/40 bg-muted/20">
            <th className="text-left font-medium text-[11px] uppercase tracking-wider text-muted-foreground px-3 py-2 w-1/4">
              {nameLabel}
            </th>
            {typeLabel && (
              <th className="text-left font-medium text-[11px] uppercase tracking-wider text-muted-foreground px-3 py-2 w-1/4">
                {typeLabel}
              </th>
            )}
            <th className="text-left font-medium text-[11px] uppercase tracking-wider text-muted-foreground px-3 py-2">
              Description
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/30 last:border-b-0">
              <td className="px-3 py-1.5 font-mono text-foreground/90 align-top">{r.name}</td>
              {typeLabel && (
                <td className="px-3 py-1.5 font-mono text-[11.5px] text-muted-foreground align-top">
                  {r.type}
                </td>
              )}
              <td className="px-3 py-1.5 text-muted-foreground align-top">{r.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
