import { onTestFinished } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOCKER_EXEC_IN_PLACE = '#!/bin/sh\nshift\nwhile [ "${1#-}" != "$1" ]; do shift; done\nshift\nexec "$@"\n';

export async function pathWithFakeDocker(): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "vibehub-fake-docker-"));
  onTestFinished(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, "docker"), DOCKER_EXEC_IN_PLACE, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}
