import coreWebVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...coreWebVitals,
  {
    ignores: ["coverage/**", "supabase/.temp/**"],
  },
  {
    rules: {
      // Loading server-owned data into state from an effect is this app's
      // accepted pattern, so it reports as a warning rather than an error.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default config;
