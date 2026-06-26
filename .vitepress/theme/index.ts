import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import LandingPage from "./components/LandingPage.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("LandingPage", LandingPage);
  },
} satisfies Theme;
