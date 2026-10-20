# vibehub — regras para agentes

## Testes: curtos, do que você tocou

A suíte inteira (back + front) leva muitos minutos e roda no CI de todo PR. No runner ela disputa CPU
com os outros cards e costuma ser morta no meio por um deploy. Rodá-la durante o trabalho é tempo
perdido. Por isso:

1. **Enquanto trabalha:** rode só o arquivo de teste do que você mexeu, filtrado pelo caso.
   `cd back && npx vitest run src/services/sdk/manager.test.ts -t "órfã"`
2. **Antes de entregar:** `npm run test:changed` (raiz). Roda só os testes afetados pela branch
   desde a `main`, o mesmo recorte do gate (`.vibehub/gate.json` → `scripts/gate-changed.sh`).
   Junto, o typecheck: `npx tsc -b` no pacote tocado (`tsc --noEmit -p` não checa nada aqui).
3. **Nunca** rode `npm test` / `npx vitest run` sem filtro no runner. A suíte inteira é do CI:
   confira com `gh pr checks <N>`.
4. Teste de tempo (limite em ms) que falha de vez em quando sob carga não é regressão sua. Confirme
   rodando sem a sua mudança antes de caçar; se for instável de antes, diga no PR e siga.

Se um comando de teste for passar de ~2 min, troque por um recorte menor.
