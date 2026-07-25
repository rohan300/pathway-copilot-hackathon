import type { Metadata } from "next";
import { Fraunces } from "next/font/google";
import "./globals.css";

/** Display serif for headings — the warm, editorial voice of the Companion design. */
const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-fraunces",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pathway Copilot",
  description:
    "Reconstruct your NHS IBD pathway state from your own letters and draft evidence-backed escalations.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={fraunces.variable}>
      <body>{children}</body>
    </html>
  );
}
