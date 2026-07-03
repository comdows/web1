import { createContext, useContext } from "react";

export type ViewName = "home" | "search" | "detail" | "compare" | "favorites" | "onboarding" | "partners" | "exchange" | "deal-guide" | "value-check" | "account" | "submit" | "admin" | "terms" | "privacy";
export type Go = (view: ViewName, params?: { id?: string; q?: string }) => void;

export const NavContext = createContext<Go>(() => {});
export const useNav = () => useContext(NavContext);
