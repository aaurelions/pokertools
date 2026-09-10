import { defineConfig } from "vitepress";
import type { PluginSimple } from "markdown-it";

/**
 * `==highlighted==` renders as <mark> (Typora-style text highlighting).
 */
const markPlugin: PluginSimple = (md) => {
  md.inline.ruler.before("emphasis", "text_mark", (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x3d || state.src.charCodeAt(start + 1) !== 0x3d) {
      return false;
    }
    const end = state.src.indexOf("==", start + 2);
    if (end === -1) return false;
    const content = state.src.slice(start + 2, end);
    if (!content.length || content.includes("=")) return false;
    if (!silent) {
      const token = state.push("html_inline", "", 0);
      token.content = `<mark>${content}</mark>`;
      token.children = [];
    }
    state.pos = end + 2;
    return true;
  });
};

/**
 * `^^underlined^^` renders as <u> (underline markup).
 */
const underlinePlugin: PluginSimple = (md) => {
  md.inline.ruler.before("emphasis", "text_underline", (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x5e || state.src.charCodeAt(start + 1) !== 0x5e) {
      return false;
    }
    const end = state.src.indexOf("^^", start + 2);
    if (end === -1) return false;
    const content = state.src.slice(start + 2, end);
    if (!content.length || content.includes("^")) return false;
    if (!silent) {
      const token = state.push("html_inline", "", 0);
      token.content = `<u>${content}</u>`;
      token.children = [];
    }
    state.pos = end + 2;
    return true;
  });
};

export default defineConfig({
  lang: "en-US",
  title: "PokerTools",
  description:
    "Enterprise-grade Texas Hold'em engine, evaluator, SDK, API and blockchain administration monorepo.",
  base: "/pokertools/",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: [
    // Allow links to the GitHub repo that may not exist yet.
    "https://github.com/aaurelions/pokertools/**",
  ],

  head: [
    ["meta", { name: "theme-color", content: "#1b6b50" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/pokertools/favicon.svg" }],
  ],

  markdown: {
    math: true,
    config: (md) => {
      md.use(markPlugin);
      md.use(underlinePlugin);
    },
  },

  themeConfig: {
    logo: "/favicon.svg",
    nav: [
      { text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/" },
      { text: "Packages", link: "/packages/types", activeMatch: "/packages/" },
      { text: "Deployment", link: "/deployment", activeMatch: "/deployment" },
      {
        text: "Changelog",
        link: "https://github.com/aaurelions/pokertools/blob/main/CHANGELOG.md",
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Architecture", link: "/guide/architecture" },
            { text: "Docs & Text Formatting", link: "/guide/formatting" },
          ],
        },
        {
          text: "Engineering",
          items: [{ text: "Engine Review (2026-09)", link: "/ENGINE_REVIEW" }],
        },
      ],
      "/packages/": [
        {
          text: "Packages",
          items: [
            { text: "Overview", link: "/packages/overview" },
            { text: "@pokertools/types", link: "/packages/types" },
            { text: "@pokertools/evaluator", link: "/packages/evaluator" },
            { text: "@pokertools/engine", link: "/packages/engine" },
            { text: "@pokertools/sdk", link: "/packages/sdk" },
            { text: "@pokertools/api", link: "/packages/api" },
            { text: "@pokertools/admin", link: "/packages/admin" },
            { text: "@pokertools/bench", link: "/packages/bench" },
            { text: "@pokertools/e2e", link: "/packages/e2e" },
          ],
        },
      ],
      // /deployment needs its own matcher — the "/guide/" and "/packages/"
      // prefixes above never match it, so it would render with no sidebar.
      "/deployment": [
        {
          text: "Deployment",
          items: [
            { text: "Deployment Guide", link: "/deployment" },
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Package Overview", link: "/packages/overview" },
          ],
        },
      ],
      // Fallback for pages outside the sections above (e.g. ENGINE_REVIEW).
      "/": [
        {
          text: "Site",
          items: [
            { text: "Home", link: "/" },
            { text: "Engine Review (2026-09)", link: "/ENGINE_REVIEW" },
          ],
        },
      ],
    },

    socialLinks: [{ icon: "github", link: "https://github.com/aaurelions/pokertools" }],

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 A.Aurelius",
    },

    editLink: {
      pattern: "https://github.com/aaurelions/pokertools/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    outline: { level: [2, 3], label: "On this page" },
    returnToTopLabel: "Back to top",
    sidebarMenuLabel: "Menu",
    darkModeSwitchLabel: "Appearance",
    lightModeSwitchTitle: "Switch to light theme",
    darkModeSwitchTitle: "Switch to dark theme",
  },
});
