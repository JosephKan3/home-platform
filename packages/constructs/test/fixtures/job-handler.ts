/** Bundling fixture for scheduled-job.test.ts. Never deployed. */
export async function handler(): Promise<void> {
  process.stdout.write(JSON.stringify({ level: "INFO", msg: "fixture.invoked" }) + "\n");
}
