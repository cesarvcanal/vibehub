import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plug, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { apiErrorMessage } from "@/lib/apiError";
import { SELECT_CLASS } from "@/features/board/components/NewCardDialog";
import { MCPS_KEY, boardApi, mcpSecretNames, mcpTransport } from "@/features/board/api";
import type { McpTransport } from "@/api/types";

/**
 * MCP servers.
 *
 * vibehub injects every MCP into EVERY Claude profile in the runner, so switching a card's account
 * never silently loses a connection. Only the shape is stored here; the values of environment
 * variables and headers go straight to the server's vault through their own route and never come
 * back, which is why the value fields always start empty.
 *
 * "Apply" re-injects everything. Claude only reads its MCP configuration at start-up, so the switch
 * next to it also restarts the idle terminals — the server skips any card that is mid-turn rather
 * than interrupting work.
 */

/** Splits a command's arguments on whitespace. There is no shell involved on the other end. */
export function splitArgs(value: string): string[] {
  return value
    .split(/\s+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

interface SecretDraft {
  key: string;
  value: string;
}

export function McpManager() {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [restartIdle, setRestartIdle] = React.useState(true);

  const [name, setName] = React.useState("");
  const [transport, setTransport] = React.useState<McpTransport>("stdio");
  const [command, setCommand] = React.useState("");
  const [args, setArgs] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [secrets, setSecrets] = React.useState<SecretDraft[]>([]);

  const { data: mcps, isLoading } = useQuery({
    queryKey: MCPS_KEY,
    queryFn: boardApi.listMcps,
    enabled: open,
  });

  const reset = React.useCallback(() => {
    setCreating(false);
    setName("");
    setTransport("stdio");
    setCommand("");
    setArgs("");
    setUrl("");
    setSecrets([]);
  }, []);

  const createMutation = useMutation({
    mutationFn: async () => {
      const keys = secrets.map((s) => s.key.trim()).filter(Boolean);
      const mcp = await boardApi.createMcp({
        name: name.trim(),
        transport,
        ...(transport === "stdio"
          ? { command: command.trim(), args: splitArgs(args) }
          : { url: url.trim() }),
        keys,
      });
      // Values go one at a time: the server only accepts a name the shape already declared.
      for (const secret of secrets) {
        const key = secret.key.trim();
        if (key && secret.value) await boardApi.setMcpSecret(mcp.id, key, secret.value);
      }
      return mcp;
    },
    onSuccess: (mcp) => {
      void queryClient.invalidateQueries({ queryKey: MCPS_KEY });
      reset();
      toast.success(`“${mcp.name}” added. Apply to inject it into the runner profiles.`);
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not add the MCP server")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => boardApi.deleteMcp(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCPS_KEY });
      toast.success("Removed. It leaves the profiles on the next apply.");
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not remove the MCP server")),
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const applied = await boardApi.applyMcps();
      if (!restartIdle) return { applied, restarted: null };
      return { applied, restarted: await boardApi.restartAllCards() };
    },
    onSuccess: ({ restarted }) => {
      toast.success(
        restarted
          ? `Applied. ${restarted.restarted} terminal(s) restarted, ${restarted.skipped} left working.`
          : "Applied to every profile in the runner.",
      );
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not apply the MCP servers")),
  });

  const canCreate =
    name.trim().length > 0 && (transport === "stdio" ? command.trim().length > 0 : url.trim().length > 0);

  return (
    <>
      <Button variant="outline" size="sm" className="h-8" onClick={() => setOpen(true)}>
        <Plug /> MCP
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>MCP servers</DialogTitle>
            <DialogDescription>
              Injected into every Claude profile in the runner, so switching a card's account never
              loses a connection. Secret values live in this server's vault, never in the browser.
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="divide-y divide-border/60 rounded-md border border-border/60">
              {(mcps ?? []).map((mcp) => {
                const keys = mcpSecretNames(mcp);
                return (
                  <div key={mcp.id} className="flex items-start gap-2.5 px-3 py-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{mcp.name}</span>
                        <Badge tone="muted" className="font-mono">
                          {mcpTransport(mcp)}
                        </Badge>
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {mcp.url ?? [mcp.command, ...(mcp.args ?? [])].filter(Boolean).join(" ")}
                      </div>
                      {keys.length ? (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {keys.map((key) => (
                            <Badge key={key} tone="muted" className="font-mono">
                              {key}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${mcp.name}`}
                      disabled={deleteMutation.isPending}
                      onClick={() => deleteMutation.mutate(mcp.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
              {(mcps ?? []).length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">No MCP servers yet.</p>
              ) : null}
            </div>
          )}

          {creating ? (
            <form
              className="space-y-3 rounded-md border border-border/60 bg-card/40 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (canCreate && !createMutation.isPending) createMutation.mutate();
              }}
            >
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-name">Name</Label>
                  <Input
                    id="mcp-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="filesystem"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-transport">Transport</Label>
                  <select
                    id="mcp-transport"
                    className={SELECT_CLASS}
                    value={transport}
                    onChange={(e) => setTransport(e.target.value as McpTransport)}
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">http</option>
                    <option value="sse">sse</option>
                  </select>
                </div>
              </div>

              {transport === "stdio" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="mcp-command">Command</Label>
                    <Input
                      id="mcp-command"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder="npx"
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mcp-args">Arguments</Label>
                    <Input
                      id="mcp-args"
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                      placeholder="-y @modelcontextprotocol/server-filesystem /work"
                      className="font-mono"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-url">URL</Label>
                  <Input
                    id="mcp-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/mcp"
                    className="font-mono"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label>{transport === "stdio" ? "Environment variables" : "Headers"}</Label>
                {secrets.map((secret, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      aria-label={`Name ${index + 1}`}
                      value={secret.key}
                      onChange={(e) =>
                        setSecrets((prev) =>
                          prev.map((s, i) => (i === index ? { ...s, key: e.target.value } : s)),
                        )
                      }
                      placeholder={transport === "stdio" ? "API_TOKEN" : "Authorization"}
                      className="font-mono"
                    />
                    <Input
                      aria-label={`Value ${index + 1}`}
                      type="password"
                      autoComplete="off"
                      value={secret.value}
                      onChange={(e) =>
                        setSecrets((prev) =>
                          prev.map((s, i) => (i === index ? { ...s, value: e.target.value } : s)),
                        )
                      }
                      placeholder="value"
                      className="font-mono"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-muted-foreground"
                      aria-label={`Remove entry ${index + 1}`}
                      onClick={() => setSecrets((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSecrets((prev) => [...prev, { key: "", value: "" }])}
                >
                  <Plus /> Add {transport === "stdio" ? "variable" : "header"}
                </Button>
              </div>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={reset}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!canCreate || createMutation.isPending}>
                  {createMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                  Add server
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              <Plus /> Add MCP server
            </Button>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={restartIdle} onCheckedChange={setRestartIdle} aria-label="Restart idle terminals" />
              Restart idle terminals
            </label>
            <Button size="sm" disabled={applyMutation.isPending} onClick={() => applyMutation.mutate()}>
              {applyMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Apply
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
