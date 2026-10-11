import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const geist = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "browser-gateway",
  description: "The Unified Interface for Headless Browsers",
  icons: {
    icon: [
      { url: "/web/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/web/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/web/browser-gateway.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/web/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster
            position="bottom-center"
            toastOptions={{
              style: {
                background: "var(--foreground)",
                color: "var(--background)",
                border: "none",
                fontSize: "12.5px",
              },
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
