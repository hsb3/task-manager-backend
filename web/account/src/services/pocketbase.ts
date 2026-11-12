import { client } from "@/lib/account";

export const pb = client(import.meta.env.VITE_PB_URL || "/");

pb.afterSend = (response, data) => {
  if (response.status === 401 && pb.authStore.isValid) {
    pb.authStore.clear();
    window.location.hash = "#/auth/login";
  }
  return data;
};
