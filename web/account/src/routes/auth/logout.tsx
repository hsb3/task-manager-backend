import { createFileRoute, redirect } from "@tanstack/react-router";
import { pb } from "@/services/pocketbase";
export const Route = createFileRoute("/auth/logout")({
  beforeLoad: () => {
    pb.authStore.clear();
    throw redirect({ to: "/auth/login" });
  },
});
