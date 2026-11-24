import type { ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Sits above the title: a back link on detail pages. */
  back?: ReactNode;
  /** Sits under the description: a row of chips summarising state. */
  meta?: ReactNode;
}

/** Title, one-sentence description, actions aligned to the bottom right. */
export function PageHeader({ title, description, actions, back, meta }: PageHeaderProps) {
  return (
    <div className="ui-pagehead">
      <div className="ui-pagehead__text">
        {back}
        <h1 className="t-h1">{title}</h1>
        {description ? <span className="t-lead">{description}</span> : null}
        {meta ? <div className="mt-1 flex flex-wrap items-center gap-1.5">{meta}</div> : null}
      </div>
      {actions ? <div className="ui-pagehead__actions">{actions}</div> : null}
    </div>
  );
}
