import type { FastifyInstance } from "fastify";
import { config } from "../config/env.js";
import { requireSession } from "../auth/session.js";
import { getSettings, updateSettings, markSetupCompleted, type SettingsPatch } from "../services/settings/settings.js";
import { setDefaultAccountLabel } from "../services/board/registry.js";
import { hostExecutor } from "../runtime/host.js";

/** Install settings the wizard and the settings screen read and write. */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", { preHandler: requireSession }, async (_req, reply) => {
    const settings = await getSettings();
    return await reply.send({
      ...settings,
      runner: {
        kind: config.runner.kind,
        container: config.runner.container,
        image: config.runner.image,
        host: hostExecutor().label,
        baseDir: config.runner.baseDir,
      },
      publicUrl: config.publicUrl,
    });
  });

  app.patch<{ Body: SettingsPatch }>("/api/settings", { preHandler: requireSession }, async (req, reply) => {
    try {
      const updated = await updateSettings(req.body ?? {});
      // The default account's display label lives in TWO documents: settings.json (what this route
      // owns) and the board config (what GET /api/accounts serves and the runner-side code reads).
      // They drifted once in production — the label saved here never showed up on the Accounts
      // screen — so a write keeps them in step.
      if (req.body?.defaultAccountLabel !== undefined) {
        await setDefaultAccountLabel(updated.defaultAccountLabel);
      }
      return await reply.send(updated);
    } catch (err) {
      return await reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post("/api/settings/setup-complete", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send(await markSetupCompleted());
  });
}
