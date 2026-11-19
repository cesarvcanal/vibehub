import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { noUnmarkedComment } from "./noUnmarkedComment.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

const code = (comment) => `${comment}\nconst answer: number = 42;`;

ruleTester.run("no-unmarked-comment", noUnmarkedComment, {
  valid: [
    code("// eslint-disable-next-line no-restricted-syntax -- live state of the driver"),
    code("/* eslint-disable no-console -- CLI output */"),
    code("// eslint-enable no-console"),
    code("// @ts-expect-error the SDK types miss the overload"),
    code('/// <reference types="vite/client" />'),
    "const mod = await import(/* @vite-ignore */ url);",
    code("// external: GitHub returns 422 for an existing PR (docs.github.com/rest/pulls#create)"),
    code("// limitation: jsdom has no ResizeObserver"),
    code("// legacy-name: `sid` is the session id persisted in board.json"),
    code("/* limitation: tmux ignores the first resize */"),
  ],
  invalid: [
    { code: code("// only live cards"), errors: [{ messageId: "unmarked" }] },
    { code: code("/** Finds the card by id */"), errors: [{ messageId: "unmarked" }] },
    { code: code("/* const old = 1; */"), errors: [{ messageId: "unmarked" }] },
    { code: code("// eslint-disable-next-line no-restricted-syntax"), errors: [{ messageId: "directiveWithoutReason" }] },
    { code: code("/* eslint-disable no-console */"), errors: [{ messageId: "directiveWithoutReason" }] },
    { code: code("// external:"), errors: [{ messageId: "emptyMarker" }] },
    { code: code("// limitation:   "), errors: [{ messageId: "emptyMarker" }] },
    { code: code("/* external: first line\n   second line */"), errors: [{ messageId: "multiline" }] },
    { code: code("// External: capitalized marker is not the marker"), errors: [{ messageId: "unmarked" }] },
  ],
});
