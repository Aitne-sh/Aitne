import { describe, it, expect } from "vitest";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("allows up to N concurrent acquires", async () => {
    const sem = new Semaphore(2);

    await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);

    // Third acquire should block
    let thirdAcquired = false;
    const p = sem.acquire().then(() => {
      thirdAcquired = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(thirdAcquired).toBe(false);

    sem.release();
    await p;
    expect(thirdAcquired).toBe(true);
  });

  it("releases in FIFO order", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];

    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));

    sem.release();
    await p1;

    sem.release();
    await p2;

    expect(order).toEqual([1, 2]);
  });

  it("tracks available permits", () => {
    const sem = new Semaphore(3);
    expect(sem.available).toBe(3);
  });
});
