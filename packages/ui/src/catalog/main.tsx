import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ComponentCatalog } from "./catalog";
import { DesktopUxContract, type ContractScreenName } from "./desktop-ux-contract";
import "./catalog.css";
import "./desktop-ux-contract.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.density =
  params.get("density") === "desktop" ? "compact" : "web";

const contractScreen = params.get("screen") as ContractScreenName | "gallery" | null;
const content = params.get("contract") === "desktop-v2.1" ? (
  <DesktopUxContract screen={contractScreen ?? "gallery"} state={params.get("state") ?? undefined} />
) : (
  <ComponentCatalog />
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>{content}</StrictMode>,
);
