import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = { title: "VOXTASK — Voice into action", description: "Capture thoughts by voice and turn them into tasks." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
