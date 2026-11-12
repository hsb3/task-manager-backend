import { createFileRoute } from "@tanstack/react-router";
import { pb } from "@/services/pocketbase";

export const Route = createFileRoute("/_authenticated/profile")({
  component: ProfilePage,
});

function ProfilePage() {
  return (
    <main className="p-6">
      <h1 className="font-semibold text-xl">Profile</h1>
      <p>{pb.authStore.record?.email}</p>
    </main>
  );
}
