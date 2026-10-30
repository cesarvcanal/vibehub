import type { StorybookConfig } from "@storybook/react-vite";

/**
 * The front's Storybook: screens drawn from fixtures, one state per story, with no back-end behind
 * them — to SEE a layout in every state it can be in (and how it moves from one to the next) before
 * shipping it. `npm run storybook` serves it on :6006; the stories live next to their component as
 * `*.stories.tsx`. Storybook reads `vite.config.ts`, so the `@/` alias and Tailwind work as in the app.
 */
const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.@(ts|tsx)"],
};

export default config;
