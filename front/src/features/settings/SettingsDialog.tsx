import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { get, patch, post, del } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import type { Settings, SettingsPatch, GithubConnection, GithubState, TranscribeStatus } from "@/api/types";
import { SELECT_CLASS } from "@/features/board/components/NewCardDialog";
import {
  LANGUAGES,
  getLanguage,
  setLanguage as applyLanguage,
  t as translate,
  useT,
  type Language,
} from "@/i18n";

/**
 * The install's own settings — the handful of things the wizard asked once and you may want to
 * change later: who the runner commits as, whether the agent asks before every tool call, what the
 * default account is called, the GitHub connection, and the keys behind voice input.
 *
 * Secrets go in, never come back: the dialog shows "stored" / "not stored" and a field that
 * replaces the value when filled.
 */

export const SETTINGS_KEY = ["settings"] as const;
export const GITHUB_KEY = ["github"] as const;
export const TRANSCRIBE_KEY = ["transcribe"] as const;

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const t = useT();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => get<Settings>("/settings"), enabled: open });
  const github = useQuery({ queryKey: GITHUB_KEY, queryFn: () => get<GithubState>("/github"), enabled: open });
  const voice = useQuery({ queryKey: TRANSCRIBE_KEY, queryFn: () => get<TranscribeStatus>("/transcribe"), enabled: open });

  const connections = github.data?.connections ?? [];

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [autonomous, setAutonomous] = React.useState(true);
  const [defaultLabel, setDefaultLabel] = React.useState("");
  const [language, setLanguage] = React.useState("");
  // Kept as a STRING: the field has to be clearable while you retype it, and "" is not 0.
  const [idleHibernate, setIdleHibernate] = React.useState("");
  const [githubLabel, setGithubLabel] = React.useState("");
  const [githubToken, setGithubToken] = React.useState("");
  const [openaiKey, setOpenaiKey] = React.useState("");
  const [anthropicKey, setAnthropicKey] = React.useState("");
  // The language is a browser choice, not a server setting, so it has its own bit of state.
  const [uiLanguage, setUiLanguage] = React.useState<Language>(() => getLanguage());

  // Hydrate the form from the server once per open; later edits are the person's.
  React.useEffect(() => {
    if (!open || !settings.data) return;
    setName(settings.data.git.name);
    setEmail(settings.data.git.email);
    setAutonomous(settings.data.autonomous);
    setDefaultLabel(settings.data.defaultAccountLabel ?? "");
    setLanguage(settings.data.transcribeLanguage ?? "");
    setIdleHibernate(String(settings.data.idleHibernateMinutes ?? 180));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings.data]);

  const save = useMutation({
    mutationFn: (body: SettingsPatch) => patch<Settings>("/settings", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      void qc.invalidateQueries({ queryKey: ["board", "accounts"] });
      toast.success(translate("toast.settingsSaved"));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const addGithub = useMutation({
    mutationFn: (body: { label: string; token: string }) =>
      post<{ connection: GithubConnection }>("/github/connections", body),
    onSuccess: (result) => {
      setGithubToken("");
      setGithubLabel("");
      void qc.invalidateQueries({ queryKey: GITHUB_KEY });
      void qc.invalidateQueries({ queryKey: ["board", "github"] });
      void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      toast.success(
        translate("toast.githubAdded", {
          label: result.connection.label,
          login: result.connection.login,
        }),
      );
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  // The server REFUSES (409) while a project still points at the account — the message names how
  // many, which is exactly what the person needs to go and fix, so it is shown verbatim.
  const removeGithub = useMutation({
    mutationFn: (id: string) => del<{ ok: true }>(`/github/connections/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: GITHUB_KEY });
      void qc.invalidateQueries({ queryKey: ["board", "github"] });
      toast.success(translate("toast.githubRemoved"));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const saveVoice = useMutation({
    mutationFn: (body: { openaiKey?: string; anthropicKey?: string }) => post<TranscribeStatus>("/transcribe/keys", body),
    onSuccess: () => {
      setOpenaiKey("");
      setAnthropicKey("");
      void qc.invalidateQueries({ queryKey: TRANSCRIBE_KEY });
      toast.success(translate("toast.voiceKeysUpdated"));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const submitGeneral = (e: React.FormEvent) => {
    e.preventDefault();
    save.mutate({
      git: { name: name.trim(), email: email.trim() },
      autonomous,
      defaultAccountLabel: defaultLabel.trim() || null,
      transcribeLanguage: language.trim() || null,
      // A blank field is not "never" — it is a field being typed in. Leave the stored value alone.
      ...(idleHibernate.trim() === "" ? {} : { idleHibernateMinutes: Number(idleHibernate.trim()) }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* grid-cols-1 pins the single column to minmax(0,1fr): without it the primitive's implicit
          grid column sizes to its widest child's min-content, and with overflow-y-auto promoting
          overflow-x to auto the hint paragraphs get CLIPPED on the right instead of wrapping. */}
      <DialogContent className="grid-cols-1 max-h-[85vh] max-w-lg overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
          <DialogDescription>
            {t("settings.description")}
          </DialogDescription>
        </DialogHeader>

        {/* Language first: it is the one setting that changes what every other line on this
            screen says, and it is not stored on the server — it belongs to this browser. */}
        <section className="space-y-3" data-testid="settings-language">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("settings.language")}
          </h3>
          <div className="space-y-1.5">
            <Label htmlFor="settings-language-select">{t("settings.languageLabel")}</Label>
            <select
              id="settings-language-select"
              className={SELECT_CLASS}
              value={uiLanguage}
              onChange={(e) => {
                const next = e.target.value as Language;
                applyLanguage(next);
                setUiLanguage(next);
              }}
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t("settings.languageHint")}</p>
          </div>
        </section>

        <form onSubmit={submitGeneral} className="space-y-4" data-testid="settings-general">
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("settings.git")}
            </h3>
            <p className="text-xs text-muted-foreground">{t("settings.gitHint")}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="settings-git-name">{t("settings.name")}</Label>
                <Input id="settings-git-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-git-email">{t("settings.email")}</Label>
                <Input id="settings-git-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("settings.agent")}
            </h3>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="settings-autonomous">{t("settings.autonomous")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings.autonomousHint")}
                </p>
              </div>
              <Switch id="settings-autonomous" checked={autonomous} onCheckedChange={setAutonomous} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settings-idle-hibernate">{t("settings.idleHibernate")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="settings-idle-hibernate"
                  type="number"
                  min={0}
                  max={10080}
                  step={5}
                  value={idleHibernate}
                  onChange={(e) => setIdleHibernate(e.target.value)}
                  className="w-28 font-mono"
                />
                <span className="text-sm text-muted-foreground">{t("settings.idleHibernateUnit")}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t("settings.idleHibernateHint")}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="settings-default-label">{t("settings.defaultLabel")}</Label>
              <Input
                id="settings-default-label"
                value={defaultLabel}
                onChange={(e) => setDefaultLabel(e.target.value)}
                placeholder="default"
                maxLength={40}
              />
              <p className="text-xs text-muted-foreground">{t("settings.defaultLabelHint")}</p>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("settings.voice")}
            </h3>
            <div className="space-y-1.5">
              <Label htmlFor="settings-language">{t("settings.transcribeLanguage")}</Label>
              <Input
                id="settings-language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder={t("settings.transcribePlaceholder")}
                maxLength={2}
                className="font-mono"
              />
            </div>
          </section>

          <div className="flex justify-end">
            <Button type="submit" disabled={save.isPending || !name.trim() || !email.trim()}>
              {save.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </form>

        <section className="space-y-3 border-t border-border/60 pt-4" data-testid="settings-github">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("settings.githubAccounts")}
          </h3>
          {/* The one thing people ask first: there is no "Sign in with GitHub" here. You paste a
              token. Saying it plainly, above the field, is cheaper than a support conversation. */}
          <p className="text-xs leading-relaxed text-muted-foreground">
            <strong className="font-medium text-foreground">{t("github.pasteToken")}</strong>
            {t("github.pasteTokenRest")}
            <span className="font-mono">repo</span>.{" "}
            <a
              href="https://github.com/settings/tokens"
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:text-foreground"
            >
              github.com/settings/tokens
            </a>
          </p>
          <p className="text-xs text-muted-foreground">
            {t("settings.githubHint")}
          </p>

          {connections.length > 0 ? (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60" data-testid="github-connections">
              {connections.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{c.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">{c.login}</span>
                      {c.scopes?.length ? ` · ${c.scopes.join(", ")}` : t("settings.fineGrained")}
                      {c.ok === false ? ` · ${c.error ?? t("settings.tokenNotUsable")}` : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={t("settings.removeAccount", { label: c.label })}
                    disabled={removeGithub.isPending}
                    onClick={() => removeGithub.mutate(c.id)}
                  >
                    {t("common.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("settings.noConnection")}
            </p>
          )}

          <div className="space-y-2 rounded-md border border-dashed border-border/60 p-3">
            <p className="text-xs font-medium">{t("settings.addAccount")}</p>
            <Input
              aria-label={t("settings.accountLabel")}
              value={githubLabel}
              onChange={(e) => setGithubLabel(e.target.value)}
              placeholder={t("settings.accountLabelPlaceholder")}
              autoComplete="off"
              maxLength={40}
            />
            <Input
              aria-label={t("settings.githubToken")}
              type="password"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              placeholder={t("github.tokenPlaceholder")}
              autoComplete="off"
              className="font-mono"
            />
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={!githubToken.trim() || addGithub.isPending}
                onClick={() => addGithub.mutate({ label: githubLabel.trim(), token: githubToken.trim() })}
              >
                {addGithub.isPending ? t("common.checking") : t("settings.addAccount")}
              </Button>
            </div>
          </div>
        </section>

        <section className="space-y-3 border-t border-border/60 pt-4" data-testid="settings-voice">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("settings.voiceKeys")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.voiceHint1")}
            {voice.data?.available ? t("settings.keyStored") : t("settings.noKey")}.{" "}
            {t("settings.voiceHint2")}
            {voice.data?.proofread ? t("settings.keyStored") : t("settings.notStored")}.
          </p>
          <div className="grid grid-cols-1 gap-2">
            <Input
              aria-label={t("settings.openaiKey")}
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder={
                voice.data?.available ? t("settings.openaiReplace") : t("settings.openaiPlaceholder")
              }
              autoComplete="off"
              className="font-mono"
            />
            <Input
              aria-label={t("settings.anthropicKey")}
              type="password"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder={
                voice.data?.proofread
                  ? t("settings.anthropicReplace")
                  : t("settings.anthropicPlaceholder")
              }
              autoComplete="off"
              className="font-mono"
            />
          </div>
          <div className="flex justify-end gap-2">
            {voice.data?.available ? (
              <Button type="button" variant="ghost" disabled={saveVoice.isPending} onClick={() => saveVoice.mutate({ openaiKey: "", anthropicKey: "" })}>
                {t("settings.removeKeys")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={saveVoice.isPending || (!openaiKey.trim() && !anthropicKey.trim())}
              onClick={() => saveVoice.mutate({
                ...(openaiKey.trim() ? { openaiKey: openaiKey.trim() } : {}),
                ...(anthropicKey.trim() ? { anthropicKey: anthropicKey.trim() } : {}),
              })}
            >
              {t("settings.saveKeys")}
            </Button>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
