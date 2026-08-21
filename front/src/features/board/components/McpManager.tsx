import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2, Pencil, Plug, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiErrorMessage } from "@/lib/apiError";
import { SELECT_CLASS } from "@/features/board/components/NewCardDialog";
import {
  MCPS_KEY,
  MCP_SECRETS_KEY,
  boardApi,
  mcpSecretStatus,
  mcpTransport,
  type BoardMcp,
} from "@/features/board/api";
import { applyOutcomeMessage } from "@/features/board/lib/applyOutcome";
import type { ApplyOutcome, McpTransport } from "@/api/types";

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
 *
 * Each server says whether it is actually USABLE: green when every name it declares has a value in
 * the vault, amber naming the ones that do not. A declared-but-empty header is an MCP that will
 * start and fail at the first call, and a row of neutral grey badges is exactly how that goes
 * unnoticed until an agent is already stuck on it.
 *
 * The pencil edits those values in place. Every field starts EMPTY — the browser never receives a
 * stored value — and only what you fill in is written, so a blank field keeps whatever is already
 * in the vault. That is what makes rotating one header a two-field edit instead of deleting the
 * server and building it again from scratch.
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
  // OFF by default: injecting the configuration is one thing, restarting somebody's terminals to
  // make it take effect is a bigger act than the button admits to. Opt in.
  const [restartIdle, setRestartIdle] = React.useState(false);

  const [name, setName] = React.useState("");
  const [transport, setTransport] = React.useState<McpTransport>("stdio");
  const [command, setCommand] = React.useState("");
  const [args, setArgs] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [secrets, setSecrets] = React.useState<SecretDraft[]>([]);

  // Which server's inline value editor is expanded. Only one at a time — two open editors of
  // password fields is a way to paste a token into the wrong one.
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const { data: mcps, isLoading } = useQuery({
    queryKey: MCPS_KEY,
    queryFn: boardApi.listMcps,
    enabled: open,
  });

  // Booleans only: which declared names already have a value. Values never leave the server.
  const { data: secretStatus } = useQuery({
    queryKey: MCP_SECRETS_KEY,
    queryFn: boardApi.mcpSecrets,
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
      void queryClient.invalidateQueries({ queryKey: MCP_SECRETS_KEY });
      reset();
      toast.success(`“${mcp.name}” added. Apply to inject it into the runner profiles.`);
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not add the MCP server")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => boardApi.deleteMcp(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCPS_KEY });
      void queryClient.invalidateQueries({ queryKey: MCP_SECRETS_KEY });
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
    onSuccess: ({ applied, restarted }) => {
      // A server that defers busy terminals reports it here; an older one just says how many it
      // restarted. Either way, never claim more than the response actually said.
      const deferred = applyOutcomeMessage(applied as { pending?: number }, "MCP servers");
      toast.success(
        restarted
          ? `Applied. ${restarted.restarted} terminal(s) restarted, ${restarted.skipped} left working.`
          : deferred,
      );
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not apply the MCP servers")),
  });

  const canCreate =
    name.trim().length > 0 && (transport === "stdio" ? command.trim().length > 0 : url.trim().length > 0);

  return (
    <>
      {/* Icon only, beside Accounts and Brain: three settings sharing one quiet corner of a board
          full of live work. */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        aria-label="MCP"
        title="MCP servers"
        onClick={() => setOpen(true)}
      >
        <Plug className="h-4 w-4" />
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setEditingId(null);
        }}
      >
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
              {(mcps ?? []).map((mcp) => (
                <McpRow
                  key={mcp.id}
                  mcp={mcp}
                  status={secretStatus?.[mcp.id]}
                  disabled={deleteMutation.isPending}
                  editing={editingId === mcp.id}
                  onToggleEdit={() => setEditingId((current) => (current === mcp.id ? null : mcp.id))}
                  onDoneEditing={() => setEditingId(null)}
                  onDelete={() => deleteMutation.mutate(mcp.id)}
                />
              ))}
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
              {/* Placeholders, not labels. Every field here is one line and self-evident from its
                  example, and a stack of headings above a stack of boxes doubles the height of a
                  form whose whole job is to be filled in once. */}
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                <Input
                  aria-label="MCP name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name (e.g. filesystem)"
                  className="font-mono"
                />
                <select
                  aria-label="Transport"
                  className={SELECT_CLASS}
                  value={transport}
                  onChange={(e) => {
                    // The pairs mean different things either side of this switch — environment
                    // variables for stdio, HTTP headers for the rest. Carrying `ROOT` over into a
                    // header list produces a server that starts and fails at its first call.
                    setTransport(e.target.value as McpTransport);
                    setSecrets([]);
                  }}
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                  <option value="sse">sse</option>
                </select>
              </div>

              {transport === "stdio" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    aria-label="Command"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="Command (e.g. npx)"
                    className="font-mono"
                  />
                  <Input
                    aria-label="Arguments"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="Arguments, space separated"
                    className="font-mono"
                  />
                </div>
              ) : (
                <Input
                  aria-label="URL"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="font-mono"
                />
              )}

              <div className="space-y-1.5">
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
                      placeholder={transport === "stdio" ? "API_TOKEN" : "Header (e.g. Authorization)"}
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
                      placeholder="value (goes to the vault)"
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
            <label
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title="Restarts only the terminals that are idle — a card mid-turn is never interrupted"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                aria-label="Restart idle terminals"
                checked={restartIdle}
                onChange={(e) => setRestartIdle(e.target.checked)}
              />
              Restart idle terminals
            </label>
            {/* Outline, not primary: saving already applied. This is the manual force for when a
                runner was unreachable at the time — and with nothing configured there is literally
                nothing to inject. */}
            <Button
              size="sm"
              variant="outline"
              disabled={applyMutation.isPending || (mcps ?? []).length === 0}
              onClick={() => applyMutation.mutate()}
            >
              {applyMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Apply now
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * One configured server. The name and target, then — when it declares any secrets — a line saying
 * in one colour whether it can actually run: green for "every value is in the vault", amber naming
 * the ones still empty.
 */
function McpRow({
  mcp,
  status,
  disabled,
  editing,
  onToggleEdit,
  onDoneEditing,
  onDelete,
}: {
  mcp: BoardMcp;
  /** `{ [name]: hasValue }` for this server, from `GET /api/mcps/secrets`. */
  status: Record<string, boolean> | undefined;
  disabled: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onDoneEditing: () => void;
  onDelete: () => void;
}) {
  const { names, missing, none, ready } = mcpSecretStatus(mcp, status);
  const target = mcp.url ?? [mcp.command, ...(mcp.args ?? [])].filter(Boolean).join(" ");

  return (
    <div>
      <div className="flex items-start gap-2.5 px-3 py-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{mcp.name}</span>
            <span className="rounded bg-muted px-1.5 font-mono text-[10px] uppercase text-muted-foreground">
              {mcpTransport(mcp)}
            </span>
          </div>
          <div title={target} className="truncate font-mono text-[11px] text-muted-foreground">
            {target}
          </div>
          {none ? null : (
            <div
              className={cn(
                "flex items-center gap-1 pt-0.5 text-[11px]",
                ready ? "text-emerald-400" : "text-amber-500",
              )}
            >
              {ready ? (
                <Check className="h-3 w-3 shrink-0" />
              ) : (
                <AlertTriangle className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate font-mono">
                {ready
                  ? `${names.length} secret${names.length === 1 ? "" : "s"} configured`
                  : `missing a value: ${missing.join(", ")}`}
              </span>
            </div>
          )}
        </div>

        {none ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`Edit values for ${mcp.name}`}
            title="Edit the stored values"
            aria-pressed={editing}
            disabled={disabled}
            onClick={onToggleEdit}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${mcp.name}`}
          disabled={disabled}
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {editing && !none ? (
        <McpSecretEditor mcp={mcp} names={names} status={status} onDone={onDoneEditing} />
      ) : null}
    </div>
  );
}

/**
 * Edit the stored values of one server, in place.
 *
 * Every field starts empty and stays a password field: the browser is never sent a stored value, so
 * there is nothing here to read back. Only what you actually type is written — a blank field keeps
 * what is already in the vault, which is what makes this the way to rotate ONE header without
 * touching the others or recreating the server.
 */
function McpSecretEditor({
  mcp,
  names,
  status,
  onDone,
}: {
  mcp: BoardMcp;
  names: string[];
  status: Record<string, boolean> | undefined;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = React.useState<Record<string, string>>({});
  const filled = names.filter((name) => (values[name] ?? "").length > 0);

  const saveMutation = useMutation({
    mutationFn: async () => {
      // One route per value: the server only accepts a name the shape already declared. Each write
      // also APPLIES — a server whose token has just arrived is exactly the one that was failing —
      // so the last outcome is what the toast reports.
      let outcome: ApplyOutcome | undefined;
      for (const name of filled) outcome = await boardApi.setMcpSecret(mcp.id, name, values[name] as string);
      return { count: filled.length, outcome };
    },
    onSuccess: ({ count, outcome }) => {
      void queryClient.invalidateQueries({ queryKey: MCP_SECRETS_KEY });
      toast.success(
        applyOutcomeMessage(outcome, `${count} value${count === 1 ? "" : "s"} on “${mcp.name}”`),
      );
      onDone();
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not save the values")),
  });

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 bg-muted/20 px-3 py-2.5">
      <p className="text-[11px] text-muted-foreground">
        Fill in only what you want to (re)set — an empty field keeps the value already in the vault.
      </p>
      {names.map((name) => {
        const stored = Boolean(status?.[name]);
        return (
          <div key={name} className="flex items-center gap-2">
            <span
              title={name}
              className={cn(
                "w-28 shrink-0 truncate font-mono text-[11px]",
                stored ? "text-muted-foreground" : "text-amber-500",
              )}
            >
              {name}
            </span>
            <Input
              type="password"
              autoComplete="off"
              aria-label={`New value for ${name}`}
              placeholder={stored ? "configured — type to replace" : "missing — set a value"}
              value={values[name] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [name]: e.target.value }))}
              className="font-mono"
            />
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={saveMutation.isPending}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saveMutation.isPending || filled.length === 0}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? <Loader2 className="animate-spin" /> : null}
          Save values
        </Button>
      </div>
    </div>
  );
}
