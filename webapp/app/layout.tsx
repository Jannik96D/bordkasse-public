import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { ToastProvider } from "@/components/toast-provider";

export const metadata: Metadata = {
  title: "Bordkasse",
  description: "Faire Kostenaufteilung auf Segeltörns",
  manifest: "/manifest.json",
  applicationName: "Bordkasse",
  appleWebApp: {
    capable: true,
    title: "Bordkasse",
    statusBarStyle: "default",
  },
  // Suchmaschinen sollen die App nicht indexieren — Crew kommt nur per
  // direktem Link rein, nicht über Google.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: { url: "/apple-icon.png", sizes: "180x180" },
  },
};

export const viewport: Viewport = {
  themeColor: "#114884",
  width: "device-width",
  initialScale: 1,
  // Randlose, native Anmutung im Standalone-Modus: erst mit viewport-fit=cover
  // liefern die `env(safe-area-inset-*)` echte Werte (sonst 0). Die fixed
  // BottomNav (pb-safe) und der sticky TripHeader (pt-safe) nutzen das.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {/* Skip-Link für Tastatur-/Screenreader-Nutzer: erst bei Fokus sichtbar */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-paper focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          Direkt zum Inhalt springen
        </a>
        {/* ServiceWorkerRegister bleibt global: der SW muss auch für
            ausgeloggte Besucher (Landing/Login/About) registriert sein, sonst
            gibt es kein Offline-Caching/keine Offline-Seite, wenn die PWA vom
            Login-Screen aus installiert wird. Der schwere OfflineBanner
            (IndexedDB-Outbox) hingegen lebt im Trip-Layout — er ist erst
            relevant, sobald offline Buchungen erfasst werden. */}
        <ServiceWorkerRegister />
        <ToastProvider>
          <div id="main-content" tabIndex={-1} className="flex min-h-full flex-1 flex-col outline-none">
            {children}
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
