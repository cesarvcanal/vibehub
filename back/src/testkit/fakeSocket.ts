import { EventEmitter } from "node:events";

export class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];
  readonly readyState = 1;
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {}
}
