import { BackgroundStateStore } from "../dist/src/background_state.js";

const [statePath, ownerId, holdText = "0"] = process.argv.slice(2);
if (!statePath || !ownerId) throw new Error("statePath and ownerId are required");
const store = new BackgroundStateStore(statePath);
const lease = await store.acquireLease(ownerId, 30_000);
process.stdout.write(`${JSON.stringify(lease)}\n`);
if (lease.acquired) {
  await new Promise((resolve) => setTimeout(resolve, Number(holdText) || 0));
  await store.releaseLease(ownerId, lease.fencing_token);
}
