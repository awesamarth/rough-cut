import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ROUGH//CUT — Agent-native video editor",
  description: "A human-first video editor with structured WebMCP tools for any compatible agent.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
