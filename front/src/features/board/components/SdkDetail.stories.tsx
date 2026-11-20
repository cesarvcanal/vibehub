import type { Meta, StoryObj } from "@storybook/react-vite";
import { SdkDetailHost } from "@/features/board/components/SdkDetail";
import { DetailChannelContext, createDetailChannel, type DetailChannel } from "@/features/board/lib/sdkDetail";
import type { SdkRow, ToolResultSummary } from "@/features/board/lib/sdkChat";

const COMMAND = "cd /root/.claude-profiles/tech/projects && grep -o 'TodoWrite.{0,300}' ./agent.jsonl | head -3";
const STDOUT = "TodoWrite, WebSearch, KillShell, BashOutput)\nTodoWrite, WebSearch, KillShell, BashOutput)\n";

function buildResult(isError: boolean): ToolResultSummary {
  return isError ? { isError, error: "exit code 2", lines: 2 } : { isError, lines: 2 };
}

function buildAnsweringChannel(isError: boolean, stderr: string): DetailChannel {
  const channel: DetailChannel = createDetailChannel((frame) => {
    queueMicrotask(() => channel.deliver({
      type: "detail",
      req: "tool",
      id: frame.id,
      nonce: frame.nonce,
      data: { found: true, by: "main", name: "Bash", input: { command: COMMAND }, structured: { stdout: STDOUT, stderr }, isError, result: buildResult(isError), startedAt: 1, endedAt: 224 },
    }));
  });
  return channel;
}

const meta = {
  title: "Chat/Detalhe de um comando",
  render: ({ isError, stderr }) => {
    const rows: SdkRow[] = [{ kind: "tool", id: "b1", name: "Bash", summary: COMMAND, input: { command: COMMAND }, result: buildResult(isError) }];
    return (
      <DetailChannelContext.Provider value={buildAnsweringChannel(isError, stderr)}>
        <SdkDetailHost rows={rows} tasks={{}} stack={[{ kind: "action", id: "b1" }]} onStack={() => undefined} />
      </DetailChannelContext.Provider>
    );
  },
} satisfies Meta<{ isError: boolean; stderr: string }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SucceededWithStderr: Story = {
  name: "Comando que deu certo, com recado no stderr",
  args: { isError: false, stderr: "\nShell cwd was reset to /work/card\n" },
};
export const FailedWithStderr: Story = {
  name: "Comando que falhou",
  args: { isError: true, stderr: "grep: ./agent.jsonl: No such file or directory\n" },
};
