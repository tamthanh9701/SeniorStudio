import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import ThemeProvider from "@/components/theme/ThemeProvider";
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

export const metadata: Metadata = {
  title: "SeniorStudio",
  description: "AI image studio for generation and immutable edits",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={geist.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(() => { try { const t = localStorage.getItem("seniorstudio-theme"); const d = t === "light" || t === "dark" ? t : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); document.documentElement.dataset.theme = d; } catch { const d = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; document.documentElement.dataset.theme = d; } })()` }} />
      </head>
      <body><ThemeProvider>{children}</ThemeProvider></body>
    </html>
  );
}
