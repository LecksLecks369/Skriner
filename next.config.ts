import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    // ошибок типов в проекте нет — пусть сборка их и дальше не пропускает
    // (вернуть скрытие: ignoreBuildErrors: true)
    ignoreBuildErrors: false,
  },
  // строгий режим влияет только на dev: помогает ловить побочные эффекты в эффектах
  reactStrictMode: true,
};

export default nextConfig;
