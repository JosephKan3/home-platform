/**
 * Used only when `usePlaceholderSource` is true (CI synth, cdk-nag, diff —
 * see `OpenNextSiteProps.usePlaceholderSource`'s doc comment for why synth
 * must work with no app checkout at all). `ScheduledJob.entry` has no
 * placeholder-source concept of its own the way `OpenNextSite` does, so
 * this stack supplies one: a trivial handler that always resolves,
 * regardless of whether the app repo (`lambda/notify/index.ts`) is checked
 * out. Never deployed for real — a real deploy must pass
 * `usePlaceholderSource: false` (the default) with a real `appRepoPath`.
 */
export async function handler(): Promise<void> {
  process.stdout.write(
    `${JSON.stringify({ service: "newnotams-notify", level: "WARN", msg: "notify.placeholder_invoked" })}\n`,
  );
}
