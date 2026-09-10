import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* Next 16 в dev отдаёт 403 на свои служебные эндпоинты (HMR-сокет, /__nextjs_font),
     если Origin запроса не в списке разрешённых. По умолчанию там только localhost, а
     проект открывается по 127.0.0.1:3000 — HMR-клиент не подключался, дев-рантайм не
     дозагружался, гидратация не происходила, и страница висела на «Первый скан…» с
     пустой таблицей. Разметка при этом приходила целиком, поэтому выглядело как
     «монеты не отображаются», а не как ошибка. */
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
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
