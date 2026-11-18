import { Suspense } from "react";
import NotificationCenter, { NotificationCenterSkeleton as CenterSkeleton } from "@/components/notifications/NotificationCenter";

export const metadata = {
  title: "Meldungscenter",
};

export default function NotificationsPage() {
  return (
    <Suspense fallback={<CenterSkeleton />}>
      <NotificationCenter />
    </Suspense>
  );
}
