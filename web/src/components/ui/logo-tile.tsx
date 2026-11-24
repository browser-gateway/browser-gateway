import * as React from "react";
import { cn } from "@/lib/utils";

interface LogoTileProps {
  /** A finished square tile image. Rendered edge to edge. */
  src?: string | null;
  name: string;
  size?: number;
  /** The image is a bare mark that needs a dark tile and padding behind it. */
  padded?: boolean;
  className?: string;
}

/** Brand logo tile. No official asset: a two-letter monogram, never a redrawn logo. */
export function LogoTile({ src, name, size = 46, padded, className }: LogoTileProps) {
  const style = { width: size, height: size, borderRadius: Math.round(size * 0.3) };
  if (!src) {
    return (
      <span aria-hidden="true" className={cn("ui-logo ui-logo--mono", className)} style={{ ...style, fontSize: Math.max(11, Math.round(size * 0.3)) }}>
        {name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?"}
      </span>
    );
  }
  return (
    <span className={cn("ui-logo", padded && "bg-ground", className)} style={{ ...style, padding: padded ? Math.round(size * 0.2) : 0 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" style={padded ? { objectFit: "contain" } : undefined} />
    </span>
  );
}
