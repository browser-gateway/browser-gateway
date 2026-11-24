"use client";

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
  requestExample: string;
  responseDescription: string;
  /** `null` for binary responses. */
  responseExample: string | null;
  responseHeaders?: { name: string; description: string }[];
  errors: DocError[];
}

export function EndpointReference({ doc }: { doc: EndpointDoc }) {
  return (
    <div className="flex flex-col gap-5">
      <p className="t-sub m-0">{doc.description}</p>

      <Section title="Headers">
        <KvTable
          label="Headers"
          rows={doc.headers.map((h) => ({ name: h.name, type: h.value, description: h.note ?? "" }))}
          nameLabel="Header"
          typeLabel="Value"
        />
      </Section>

      <Section title="Request body">
        <KvTable label="Request body" rows={doc.parameters.map(parameterRow)} />
        <CodeBlock code={doc.requestExample} lang="json" filename="request.json" />
      </Section>

      <Section title="Response">
        <p className="t-sub m-0">{doc.responseDescription}</p>
        {doc.responseExample ? <CodeBlock code={doc.responseExample} lang="json" filename="response.json" maxHeight="320px" /> : null}
        {doc.responseHeaders && doc.responseHeaders.length > 0 ? (
          <KvTable
            label="Response headers"
            rows={doc.responseHeaders.map((h) => ({ name: h.name, type: "", description: h.description }))}
            nameLabel="Response header"
            typeLabel=""
          />
        ) : null}
      </Section>

      <Section title="Status codes">
        <KvTable
          label="Status codes"
          rows={doc.errors.map((e) => ({ name: String(e.status), type: "", description: e.meaning }))}
          nameLabel="Status"
          typeLabel=""
        />
      </Section>
    </div>
  );
}

function parameterRow(p: DocParameter): KvRow {
  const typePart = p.required ? `${p.type} · required` : p.default ? `${p.type} · default ${p.default}` : p.type;
  return { name: p.name, type: typePart, description: p.description };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[7px]">
      <h3 className="t-label m-0">{title}</h3>
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
  label,
  rows,
  nameLabel = "Field",
  typeLabel = "Type",
}: {
  label: string;
  rows: KvRow[];
  nameLabel?: string;
  typeLabel?: string;
}) {
  return (
    <div role="table" aria-label={label} className="flex flex-col rounded-2xl border border-line bg-ground px-3">
      <div role="row" className="t-th flex gap-3 border-b border-line-divider py-2 max-[860px]:hidden">
        <span role="columnheader" className="flex-[1_1_140px]">{nameLabel}</span>
        {typeLabel ? <span role="columnheader" className="flex-[1_1_160px]">{typeLabel}</span> : null}
        <span role="columnheader" className="flex-[2_1_220px]">Description</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} role="row" className="flex flex-wrap gap-x-3 gap-y-1 border-b border-line-faint py-2.5 last:border-b-0">
          <span role="cell" className="flex-[1_1_140px] font-mono text-[12.5px] font-medium text-fg [overflow-wrap:anywhere]">{r.name}</span>
          {typeLabel ? (
            <span role="cell" className="flex-[1_1_160px] font-mono text-xs text-fg-2 [overflow-wrap:anywhere]">{r.type}</span>
          ) : null}
          <span role="cell" className="flex-[2_1_220px] text-[13px] text-fg-2">{r.description}</span>
        </div>
      ))}
    </div>
  );
}
