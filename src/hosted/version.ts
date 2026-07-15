// The deployed kernel names the commit it was built from, so "the code is
// open" becomes a specific, falsifiable claim about this running server rather
// than a vague one about a repository. Vercel injects the git SHA;
// SUMINAR_SOURCE_URL points at the public repository once it exists.

export function handleHostedVersionRequest(env: NodeJS.ProcessEnv = process.env): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      name: "suminar-kernel",
      commit: env.VERCEL_GIT_COMMIT_SHA ?? null,
      ref: env.VERCEL_GIT_COMMIT_REF ?? null,
      source: env.SUMINAR_SOURCE_URL ?? null,
      license: "Apache-2.0",
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    },
  );
}
