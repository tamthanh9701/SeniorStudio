import coreWebVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...coreWebVitals,
  {
    ignores: ["coverage/**", "supabase/.temp/**"],
  },
];

export default config;
