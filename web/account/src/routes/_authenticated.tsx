import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated")({
  component: Outlet,
  beforeLoad: ({ context, location }) => {
    if (!context.isAuthenticated)
      throw redirect({
        to: "/auth/login",
        search: { redirect: location.href },
      });
  },
});
