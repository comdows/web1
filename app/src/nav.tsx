import { createContext, useContext } from "react";

export type ViewName = "home" | "search" | "detail" | "compare" | "favorites" | "onboarding" | "partners" | "exchange" | "deal-guide" | "value-check" | "ai-finder" | "weekly" | "packs" | "news" | "guide" | "account" | "submit" | "admin" | "terms" | "privacy" | "notifications" | "optout" | "deal" | "support";
export type Go = (view: ViewName, params?: { id?: string; q?: string }) => void;

export const NavContext = createContext<Go>(() => {});
export const useNav = () => useContext(NavContext);
