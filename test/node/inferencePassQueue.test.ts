import { expect, it } from "vitest";
import { InferencePassQueue } from "../../lib/webengine/scheduling";

it("finishes the active pass, serves visible work, then resumes background work", async () => {
  const queue = new InferencePassQueue();
  const active = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = queue.run("background", () => active.promise);
  const background = queue.run("background", async () => { order.push("resumed"); });
  const visible = queue.run("viewport", async () => { order.push("visible"); throw Error("cancelled"); });
  const rejected = expect(visible).rejects.toThrow("cancelled");
  active.resolve();
  await Promise.all([first, background, rejected]);
  expect(order).toEqual(["visible", "resumed"]);
});

it("admits a waiting background pass even with continuous visible work", async () => {
  const queue = new InferencePassQueue();
  const active = Promise.withResolvers<void>();
  const first = queue.run("viewport", () => active.promise);
  const order: string[] = [];
  const waiting = queue.run("background", async () => { order.push("background"); });
  const visible = Array.from({ length: 12 }, () => queue.run("viewport", async () => { order.push("visible"); }));
  active.resolve();
  await Promise.all([first, waiting, ...visible]);
  expect(order.indexOf("background")).toBeLessThanOrEqual(4);
});
