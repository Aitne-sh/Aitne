import nextConfig from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  { ignores: ["coverage/**"] },
  ...nextConfig,
];

export default eslintConfig;
