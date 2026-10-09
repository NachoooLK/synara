// Sample data. A real mod would read this from a service the person uses.
export interface PullRequest {
  readonly id: number;
  readonly title: string;
  readonly author: string;
  readonly state: "OPEN" | "MERGED";
  readonly description: string;
  readonly diff: string;
}

export const PULL_REQUESTS: readonly PullRequest[] = [
  {
    id: 412,
    title: "Payments: retry with backoff",
    author: "ana",
    state: "OPEN",
    description:
      "Adds **retries** with exponential backoff to the payments client.\n\n- At most 3 attempts\n- Logs the reason",
    diff: "--- a/payments/client.ts\n+++ b/payments/client.ts\n@@ -10,1 +10,1 @@\n-  return fetch(url)\n+  return retry(() => fetch(url), { attempts: 3 })",
  },
  {
    id: 415,
    title: "Login: handle expired sessions",
    author: "luis",
    state: "MERGED",
    description:
      "Redirects to the login page when the session expires instead of showing an error.",
    diff: "--- a/auth/session.ts\n+++ b/auth/session.ts\n@@ -1 +1 @@\n-throw new Error('expired')\n+return redirect('/login')",
  },
];
