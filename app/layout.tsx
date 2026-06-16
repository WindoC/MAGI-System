import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "MAGI System",
  description: "Transparent multi-agent deliberation MVP"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
