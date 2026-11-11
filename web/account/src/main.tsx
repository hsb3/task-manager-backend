import "@/styles/globals.css";

import React from "react";
import ReactDOM from "react-dom/client";
import {
  RouterProvider,
  createHashHistory,
  createRouter,
} from "@tanstack/react-router";

import { routeTree } from "./route-tree.gen";

const router = createRouter({
  routeTree,
  history: createHashHistory(),
  context: { isAuthenticated: undefined! },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
