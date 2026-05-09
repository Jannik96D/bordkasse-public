import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { OfflineBanner } from "@/components/offline-banner";

export const metadata: Metadata = {
  title: "Bordkasse",
  description: "Faire Kostenaufteilung auf Segel-Törns",
  manifest: "/manifest.json",
  applicationName: "Bordkasse",
  appleWebApp: {
    capable: true,
    title: "Bordkasse",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#114884",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <ServiceWorkerRegister />
        <OfflineBanner />
        {children}
      </body>
    </html>
  );
}
