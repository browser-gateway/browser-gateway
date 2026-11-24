import type { Metadata } from "next";
import localFont from "next/font/local";
import { Toaster } from "sonner";
import "./globals.css";

const dmSans = localFont({
  src: "./fonts/DMSans-Variable.woff2",
  variable: "--font-dm-sans",
  weight: "100 1000",
});

const dmMono = localFont({
  src: [
    { path: "./fonts/DMMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/DMMono-Medium.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-dm-mono",
});

export const metadata: Metadata = {
  title: "browser-gateway",
  description: "The open router for cloud browsers",
  icons: {
    icon: [
      { url: "/web/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/web/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/web/browser-gateway.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/web/apple-touch-icon.png", sizes: "180x180" }],
  },
  other: {
    "theme-color": "#0b0a10",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${dmMono.variable} dark h-full`}>
      <body className="min-h-full antialiased">
        {children}
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: {
              background: "var(--bg-raised)",
              color: "var(--text)",
              border: "1px solid var(--line)",
              borderRadius: "14px",
              fontSize: "13px",
            },
          }}
        />
      </body>
    </html>
  );
}
