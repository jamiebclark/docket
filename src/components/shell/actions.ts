"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/server/auth/auth";

/** Ends the session (the `nextCookies` plugin clears the cookies) and returns to the login page. */
export async function signOut(): Promise<void> {
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/login");
}
