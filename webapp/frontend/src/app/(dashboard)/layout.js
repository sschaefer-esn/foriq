"use client";

import { useAuth, signOut } from "@/lib/auth";
import { useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";
import { MotionConfig } from "framer-motion";
import { SWRConfig } from "swr";
import api from "@/lib/api";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";
import NotificationProvider from "@/components/providers/NotificationProvider";
import FleetLiveProvider from "@/components/providers/FleetLiveProvider";
import DeviceOverlay from "@/components/devices/DeviceOverlay";

export default function DashboardLayout({ children }) {
  const { data: session, status } = useAuth();
  const router = useRouter();

  const hasCompany = Boolean(session?.user?.companyId);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    } else if (status === "authenticated" && !hasCompany) {
      // Without a company membership there is nothing to show → sign in again.
      signOut({ callbackUrl: "/login" });
    }
  }, [status, hasCompany, router]);

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <span className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      </div>
    );
  }

  if (!session || !hasCompany) {
    return null;
  }

  return (
    <SWRConfig
      value={{ fetcher: (url) => api.get(url).then((r) => r.data) }}
    >
      <NotificationProvider>
        <FleetLiveProvider>
          <MotionConfig reducedMotion="user">
            <div className="flex h-screen bg-background">
              <Sidebar />
              <div className="flex flex-1 flex-col overflow-hidden">
                <Header />
                {/* z-0 keeps the overlay z-index below the header; otherwise the
                    modal paints over the user menu (clicks miss). */}
                <div className="relative z-0 flex-1 overflow-hidden">
                  {/* scrollbar-gutter both-edges reserves the scrollbar width
                      symmetrically so centred content does not jump horizontally
                      on tab/page changes when the scrollbar appears/disappears */}
                  <main className="h-full overflow-y-auto px-4 pb-6 pt-2 md:px-8 md:pb-10 md:pt-4 [scrollbar-gutter:stable_both-edges]">
                    {children}
                  </main>
                  <Suspense fallback={null}>
                    <DeviceOverlay />
                  </Suspense>
                </div>
              </div>
            </div>
          </MotionConfig>
        </FleetLiveProvider>
      </NotificationProvider>
    </SWRConfig>
  );
}
