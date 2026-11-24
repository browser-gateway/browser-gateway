interface GatewayLogoProps {
  size?: number;
  className?: string;
}

export function GatewayLogo({ size = 26, className }: GatewayLogoProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/web/browser-gateway.svg" alt="browser-gateway" width={size} height={size} className={className} />
  );
}
