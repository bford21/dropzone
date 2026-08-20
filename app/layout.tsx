import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dropzone — Flaunch Arena FPS",
  description: "A fast, server-authoritative browser FPS built for Flaunch Game Mode.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
