import { BackgroundStateStore } from "../dist/src/background_state.js";

const [statePath, ownerId, holdText = "0"] = process.argv.slice(2);
if (!statePath || !ownerId) throw new Error("statePath and ownerId are required");
const store = new BackgroundStateStore(statePath);
const lease = await store.acquireLease(ownerId, 30_000);
process.stdout.write(`${JSON.stringify(lease)}\n`);
if (lease.acquired) {
  if (holdText === "signal") {
    await new Promise((resolve, reject) => {
      process.stdin.once("data", resolve);
      process.stdin.once("end", resolve);
      process.stdin.once("error", reject);
      process.stdin.resume();
    });
  } else {
    await new Promise((resolve) => setTimeout(resolve, Number(holdText) || 0));
  }
  await store.releaseLease(ownerId, lease.fencing_token);
}
