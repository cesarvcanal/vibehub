import { describe, it, expect } from "vitest";
import { createLineReader } from "./lineReader.js";

describe("createLineReader", () => {
  it("returns only whole lines and keeps the unfinished tail for the next chunk", () => {
    const read = createLineReader();
    expect(read(Buffer.from("a\nb"))).toEqual(["a"]);
    expect(read(Buffer.from("c\n"))).toEqual(["bc"]);
  });

  it("keeps a multibyte character whole when a chunk ends inside it", () => {
    const read = createLineReader();
    const bytes = Buffer.from("ação\n", "utf8");
    expect(read(bytes.subarray(0, 2))).toEqual([]); // "a" + first byte of "ç"
    expect(read(bytes.subarray(2))).toEqual(["ação"]);
  });

  it("drops an unfinished line that grows past maxPending", () => {
    const read = createLineReader(4);
    expect(read(Buffer.from("123456"))).toEqual([]);
    expect(read(Buffer.from("ok\n"))).toEqual(["ok"]);
  });
});
