import type { Env } from "../env";

export interface DispatchPayload {
  jobId: string;
  action: "process" | "chunk" | "export" | "optimize" | "frameopt";
  exportId?: string;
  batchId?: string;
}

/**
 * Wake the GitHub Actions processor via repository_dispatch. The workflow runs
 * the Python/OpenCV runner (`processor/local_runner.py --once`) on GitHub's free
 * 24/7 runners, so frames/chunks/exports are processed even when the laptop is
 * off. The payload is a hint only — the runner drains the whole queue each run.
 */
export async function triggerGitHubDispatch(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  payload: DispatchPayload
): Promise<boolean> {
  const { GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO } = env;
  if (!GITHUB_PAT || !GITHUB_OWNER || !GITHUB_REPO) {
    console.log("GitHub dispatch not configured — processor must poll");
    return false;
  }
  const body = JSON.stringify({ event_type: "process", client_payload: payload });
  const fire = () =>
    fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${GITHUB_PAT}`,
        "content-type": "application/json",
        "user-agent": "kenduit-worker",
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      body,
    });
  // Fire-and-forget with a couple of retries so a slow dispatch never blocks the
  // admin response (runs off the request CPU budget via waitUntil).
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fire();
        if (res.ok) return;
        console.log(`github dispatch attempt ${attempt + 1} -> HTTP ${res.status}`);
      } catch (err) {
        console.log("github dispatch error", err);
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  };
  ctx.waitUntil(run());
  return true;
}
