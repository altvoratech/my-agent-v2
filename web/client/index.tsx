import React from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import App from "./App";
import "./globals.css";

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(
    // <Theme> publica os tokens do Radix (cor, raio, escala) como CSS vars e
    // envolve os portais dos componentes dele. Fica na entrada, não no App,
    // para alcançar também os modais renderizados fora da árvore de layout.
    // Ajuste a identidade visual aqui: accentColor / grayColor / radius / scaling.
    <Theme appearance="light" accentColor="indigo" grayColor="slate" radius="medium">
      <App />
    </Theme>,
  );
}
