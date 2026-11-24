import { EventEmitter } from "node:events";

export interface FakeDriverChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (s: string) => boolean; end: () => void; written: string[]; writable: boolean };
  exitCode: number | null;
  kill: () => void;
}

export function fakeDriverChild(): FakeDriverChild {
  const child = new EventEmitter() as FakeDriverChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as FakeDriverChild["stdin"];
  stdin.written = [];
  stdin.writable = true;
  stdin.write = (s: string) => { stdin.written.push(s); return true; };
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => undefined;
  return child;
}
