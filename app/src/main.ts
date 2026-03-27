import { createApp } from "vue";
import { createVuetify } from "vuetify";
import { aliases, mdi } from "vuetify/iconsets/mdi";
import App from "./App.vue";
import "vuetify/styles";
import "@mdi/font/css/materialdesignicons.css";
import "./style.css";

const vuetify = createVuetify({
  theme: {
    defaultTheme: "sqlHelperDark",
    themes: {
      sqlHelperDark: {
        dark: true,
        colors: {
          background: "#07111f",
          surface: "#0f172a",
          "surface-bright": "#162238",
          primary: "#60a5fa",
          secondary: "#34d399",
          error: "#fb7185",
          info: "#38bdf8",
          success: "#10b981",
          warning: "#f59e0b"
        }
      }
    }
  },
  icons: {
    defaultSet: "mdi",
    aliases,
    sets: { mdi }
  },
  defaults: {
    VCard: {
      rounded: "xl"
    },
    VBtn: {
      rounded: "pill"
    },
    VTextField: {
      variant: "outlined",
      density: "comfortable",
      hideDetails: true
    },
    VSelect: {
      variant: "outlined",
      density: "comfortable",
      hideDetails: true
    },
    VTextarea: {
      variant: "outlined",
      density: "comfortable",
      hideDetails: true
    }
  }
});

createApp(App).use(vuetify).mount("#app");
